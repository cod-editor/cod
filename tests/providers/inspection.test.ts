import { test } from "node:test";
import assert from "node:assert/strict";
import { NativeInspection } from "../../src/providers/inspection.ts";
import { parseProviderCommand } from "../../src/provider-commands.ts";
test("session commands never include paths or slash prose", () => {
  assert.equal(parseProviderCommand("/status"), "status");
  assert.equal(parseProviderCommand("/imaginary"), "unknown");
  assert.equal(parseProviderCommand("/tmp/file"), undefined);
  assert.equal(parseProviderCommand("/status is misleading"), undefined);
});
test("inspector exposes only safe effective config fields", async () => {
  const result = await new NativeInspection().read(
    "codex",
    "native",
    "/fixture",
    "config",
    async (method, params) => {
      assert.equal(method, "config/read");
      assert.deepEqual(params, { cwd: "/fixture", includeLayers: false });
      return {
        config: {
          model: "fixture-model",
          approval_policy: "on-request",
          env: { TOKEN: "secret" },
          api_key: "secret",
          mcp_servers: { secret: { env: { PASSWORD: "secret" } } },
        },
      };
    },
  );
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(
    result.fields.map((f) => f.value),
    ["fixture-model", "on-request"],
  );
});
test("usage stays unavailable until native telemetry and weekly window is provider supplied", async () => {
  const inspector = new NativeInspection();
  const request = async () => ({
    rateLimits: {
      limitId: "fixture",
      secondary: {
        usedPercent: 25,
        windowDurationMins: 10080,
        resetsAt: 2000000000,
      },
    },
  });
  const before = await inspector.read(
    "codex",
    "n",
    "/fixture",
    "status",
    request,
  );
  assert.ok(
    before.unavailable.some((s) => s.includes("Context usage unavailable")),
  );
  inspector.updateUsage({
    last: { inputTokens: 120, totalTokens: 150 },
    total: { totalTokens: 900 },
    modelContextWindow: 1000,
  });
  const after = await inspector.read(
    "codex",
    "n",
    "/fixture",
    "status",
    request,
  );
  assert.ok(
    after.fields.some(
      (f) => f.label === "Last input tokens" && f.value === "120",
    ),
  );
  assert.ok(
    after.fields.some(
      (f) => f.label === "fixture weekly" && f.value.startsWith("25% used"),
    ),
  );
});
test("skills retain native identity and disabled entries cannot be invoked", async () => {
  const result = await new NativeInspection().read(
    "codex",
    "n",
    "/fixture",
    "skills",
    async () => ({
      data: [
        {
          skills: [
            {
              name: "demo",
              path: "/fixture/SKILL.md",
              enabled: true,
              description: "Example",
            },
            { name: "disabled", path: "/fixture/disabled", enabled: false },
          ],
          errors: [],
        },
      ],
    }),
  );
  assert.deepEqual(result.entries[0].skill, {
    name: "demo",
    path: "/fixture/SKILL.md",
  });
  assert.equal(result.entries[1].skill, undefined);
});
test("subagents filter by native parent across pages", async () => {
  let count = 0;
  const result = await new NativeInspection().read(
    "codex",
    "parent",
    "/fixture",
    "agents",
    async () =>
      ++count === 1
        ? {
            data: [{ id: "other", parentThreadId: "other-parent" }],
            nextCursor: "next",
          }
        : {
            data: [
              {
                id: "child",
                parentThreadId: "parent",
                agentNickname: "Worker",
                status: { type: "active" },
              },
            ],
            nextCursor: null,
          },
  );
  assert.equal(count, 2);
  assert.deepEqual(
    result.entries.map((e) => e.id),
    ["child"],
  );
});
test("unsupported Kimi inspection never invents native APIs", async () => {
  const result = await new NativeInspection().read(
    "kimi",
    "native",
    "/fixture",
    "skills",
    async () => {
      throw new Error("must not request");
    },
  );
  assert.ok(result.unavailable[0].includes("Kimi ACP"));
  assert.deepEqual(result.entries, []);
});

test("native adapter attaches verified skills and captures thread-scoped telemetry", async () => {
  const { createCodexAdapter } = await import("../../src/providers/index.ts");
  const { fileURLToPath } = await import("node:url");
  const adapter = createCodexAdapter({
    cwd: process.cwd(),
    executable: process.execPath,
    args: [fileURLToPath(new URL("./inspection-fixture.mjs", import.meta.url))],
    requestTimeoutMs: 1000,
  });
  try {
    await adapter.create();
    await assert.rejects(
      adapter.send("Use $duplicate"),
      /Choose a specific skill/,
    );
    await assert.rejects(
      adapter.resolveSkills("Use $duplicate", [
        { name: "duplicate", path: "/untrusted/SKILL.md" },
      ]),
      /no longer available/,
    );
    await adapter.send(
      "Use $duplicate",
      [],
      [{ name: "duplicate", path: "/second/SKILL.md" }],
    );
    await adapter.send("Use $example for this invented fixture");
    const result = await adapter.inspect("status");
    assert.ok(
      result.fields.some(
        (f) => f.label === "Last input tokens" && f.value === "42",
      ),
    );
    assert.equal(
      result.fields.some((f) => f.value === "999"),
      false,
    );
  } finally {
    await adapter.dispose();
  }
});
