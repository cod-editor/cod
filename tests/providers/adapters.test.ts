import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createCodexAdapter,
  createKimiAdapter,
} from "../../src/providers/index.ts";
import type { ProviderEvent, ProviderId } from "../../src/providers/types.ts";
const fixture = fileURLToPath(new URL("./fake-provider.mjs", import.meta.url));
function setup(provider: ProviderId, mode = "normal") {
  const events: ProviderEvent[] = [];
  const adapter = (
    provider === "codex" ? createCodexAdapter : createKimiAdapter
  )({
    cwd: process.cwd(),
    executable: process.execPath,
    args: [fixture, provider, mode],
    requestTimeoutMs: 500,
    turnTimeoutMs: 2000,
    onEvent: (event) => events.push(event),
  });
  return { adapter, events };
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Expected event was not delivered");
    await new Promise((r) => setTimeout(r, 5));
  }
}
for (const provider of ["codex", "kimi"] as const) {
  test(`${provider}: native identity, routed text/tools, discovery and completion`, async () => {
    const { adapter, events } = setup(provider);
    try {
      assert.equal((await adapter.create()).nativeId, `${provider}-native`);
      assert.equal(
        (await adapter.discover())[0].nativeId,
        `${provider}-native`,
      );
      assert.equal((await adapter.send("invented prompt")).status, "completed");
      assert.deepEqual(
        events
          .filter((e) => e.type === "text")
          .map((e) => e.type === "text" && e.text),
        ["hello"],
      );
      assert.ok(events.some((e) => e.type === "tool"));
      assert.equal(events.filter((e) => e.type === "completed").length, 1);
      await assert.rejects(adapter.create(), /already/i);
    } finally {
      await adapter.dispose();
    }
  });
  test(`${provider}: permissions require explicit valid answers and foreign requests are rejected`, async () => {
    const { adapter, events } = setup(provider, "approval");
    try {
      await adapter.create();
      const turn = adapter.send("invented approval");
      await until(() => events.some((e) => e.type === "permission"));
      const permission = events.find((e) => e.type === "permission");
      assert.ok(permission?.type === "permission");
      assert.equal(events.filter((e) => e.type === "permission").length, 1);
      await assert.rejects(
        adapter.permission(permission.requestId, "invented-invalid"),
        /option/i,
      );
      const deny = permission.options.find((o) => o.kind === "reject_once");
      assert.ok(deny);
      await adapter.permission(permission.requestId, deny.id);
      await turn;
      assert.ok(events.some((e) => e.type === "text" && e.text === "DENIED"));
      await assert.rejects(
        adapter.permission(permission.requestId, deny.id),
        /permission/i,
      );
    } finally {
      await adapter.dispose();
    }
  });
  test(`${provider}: cancellation preserves controller and forbids overlapping sends`, async () => {
    const { adapter, events } = setup(provider, "cancel");
    try {
      await adapter.create();
      const turn = adapter.send("long invented turn");
      await until(() => events.some((e) => e.type === "text"));
      await assert.rejects(adapter.send("overlap"), /active/i);
      await assert.rejects(adapter.getOptions(), { code: "busy" });
      await assert.rejects(
        adapter.setOption({ option: "model", value: "unused" }),
        { code: "busy" },
      );
      await adapter.cancel();
      assert.equal((await turn).status, "cancelled");
    } finally {
      await adapter.dispose();
    }
  });
  test(`${provider}: dispose rejects active work and is idempotent`, async () => {
    const { adapter, events } = setup(provider, "dispose");
    await adapter.create();
    const turn = adapter.send("pending");
    const rejected = assert.rejects(turn, /closed|disposed/i);
    await until(() => events.some((e) => e.type === "text"));
    await adapter.dispose();
    await rejected;
    await adapter.dispose();
    await assert.rejects(adapter.send("after close"), /closed|disposed/i);
  });
  for (const mode of ["malformed", "exit", "timeout", "oversized"])
    test(`${provider}: ${mode} fails initialization without hanging`, async () => {
      const { adapter } = setup(provider, mode);
      try {
        await assert.rejects(adapter.create());
      } finally {
        await adapter.dispose();
      }
    });
  for (const mode of ["rpc-error", "crash-turn"])
    test(`${provider}: ${mode} rejects active work`, async () => {
      const { adapter, events } = setup(provider, mode);
      try {
        await adapter.create();
        await assert.rejects(adapter.send("test"));
        assert.ok(events.some((e) => e.type === "error"));
      } finally {
        await adapter.dispose();
      }
    });
  test(`${provider}: resume keeps native ID and supplies native history`, async () => {
    const { adapter, events } = setup(provider);
    try {
      assert.equal(
        (await adapter.resume(`${provider}-native`)).nativeId,
        `${provider}-native`,
      );
      assert.ok(
        events.some((e) =>
          provider === "codex"
            ? e.type === "history"
            : e.type === "text" && e.replay,
        ),
      );
    } finally {
      await adapter.dispose();
    }
  });
}
test("Codex resume rejects substituted native identity", async () => {
  const { adapter } = setup("codex", "wrong-id");
  try {
    await assert.rejects(adapter.resume("codex-native"), /identity/i);
  } finally {
    await adapter.dispose();
  }
});

for (const provider of ["codex", "kimi"] as const) {
  for (const mode of ["split", "unmatched", "stderr"])
    test(`${provider}: ${mode} cannot contaminate protocol responses`, async () => {
      const { adapter, events } = setup(provider, mode);
      try {
        await adapter.create();
        assert.equal((await adapter.send("invented")).status, "completed");
        assert.deepEqual(
          events
            .filter((e) => e.type === "text")
            .map((e) => e.type === "text" && e.text),
          ["hello"],
        );
      } finally {
        await adapter.dispose();
      }
    });
}
test("Codex cancellation requested before turn acceptance is delivered after native identity arrives", async () => {
  const { adapter } = setup("codex", "early-cancel");
  try {
    await adapter.create();
    const turn = adapter.send("invented");
    await adapter.cancel();
    assert.equal((await turn).status, "cancelled");
  } finally {
    await adapter.dispose();
  }
});
test("Subscriptions may detach and throwing consumers cannot break protocol progress", async () => {
  const { adapter } = setup("codex");
  let detachedEvents = 0;
  const detach = adapter.subscribe(() => detachedEvents++);
  detach();
  adapter.subscribe(() => {
    throw new Error("invented UI failure");
  });
  try {
    await adapter.create();
    await adapter.send("invented");
    assert.equal(detachedEvents, 0);
  } finally {
    await adapter.dispose();
  }
});

for (const provider of ["codex", "kimi"] as const) {
  test(`${provider}: stale permission answer cannot target a resumed controller`, async () => {
    const first = setup(provider, "approval");
    let oldRequestId: string;
    let nativeId: string;
    try {
      nativeId = (await first.adapter.create()).nativeId;
      const oldTurn = first.adapter.send("old permission");
      const disposedTurn = assert.rejects(oldTurn, /disposed/i);
      await until(() =>
        first.events.some((event) => event.type === "permission"),
      );
      const oldPermission = first.events.find(
        (event) => event.type === "permission",
      );
      assert.ok(oldPermission?.type === "permission");
      oldRequestId = oldPermission.requestId;
      await first.adapter.dispose();
      await disposedTurn;
    } finally {
      await first.adapter.dispose();
    }
    const second = setup(provider, "approval");
    try {
      await second.adapter.resume(nativeId);
      const newTurn = second.adapter.send("new permission");
      // Attach a rejection handler immediately so failure cleanup cannot leak it.
      const settledTurn = newTurn.then(
        (outcome) => ({ outcome }),
        (error: unknown) => ({ error }),
      );
      await until(() =>
        second.events.some((event) => event.type === "permission"),
      );
      const current = second.events.find(
        (event) => event.type === "permission",
      );
      assert.ok(current?.type === "permission");
      const allow = current.options.find(
        (option) => option.kind === "allow_once",
      );
      const deny = current.options.find(
        (option) => option.kind === "reject_once",
      );
      assert.ok(allow && deny);
      await assert.rejects(
        second.adapter.permission(oldRequestId, allow.id),
        /permission/i,
      );
      assert.notEqual(current.requestId, oldRequestId);
      assert.equal(
        second.events.filter((event) => event.type === "permission-resolved")
          .length,
        0,
      );
      await second.adapter.permission(current.requestId, deny.id);
      const result = await settledTurn;
      assert.ok("outcome" in result);
      assert.equal(result.outcome.status, "completed");
      assert.ok(
        second.events.some(
          (event) => event.type === "text" && event.text === "DENIED",
        ),
      );
      assert.equal(
        second.events.some(
          (event) => event.type === "text" && event.text === "ALLOWED",
        ),
        false,
      );
    } finally {
      await second.adapter.dispose();
    }
  });
}

for (const provider of ["codex", "kimi"] as const) {
  test(
    `${provider}: dispose terminates its tool group after the controller exits`,
    { skip: process.platform === "win32" },
    async () => {
      const { adapter } = setup(provider, "owned-child");
      let toolPid: number | undefined;
      try {
        const conversation = await adapter.create();
        const metadata = conversation.metadata as {
          thread?: { toolPid: number };
          toolPid?: number;
        };
        toolPid = metadata.thread?.toolPid ?? metadata.toolPid;
        assert.ok(toolPid && toolPid !== process.pid);
        process.kill(toolPid, 0);
        await adapter.dispose();
        await until(() => {
          try {
            process.kill(toolPid!, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        });
      } finally {
        await adapter.dispose();
        // A red regression must also clean up the exact tool PID it created.
        if (toolPid) {
          try {
            process.kill(toolPid, "SIGKILL");
          } catch {}
        }
      }
    },
  );
}

for (const provider of ["codex", "kimi"] as const) {
  for (const resume of [false, true]) {
    for (const enabled of [false, true]) {
      test(`${provider}: ${resume ? "resume" : "create"} sends ${enabled ? "only explicit context overlay" : "unchanged defaults"}`, async () => {
        const { mkdtemp, readFile, rm } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = await mkdtemp(join(tmpdir(), "cod-context-contract-"));
        const log = join(dir, "requests.jsonl");
        const contextServer = {
          name: "cod_fixture_unique",
          command: process.execPath,
          args: ["/invented/context-server.cjs"],
          env: { COD_WORKSPACE_ID: "invented" },
        };
        const adapter = (
          provider === "codex" ? createCodexAdapter : createKimiAdapter
        )({
          cwd: process.cwd(),
          executable: process.execPath,
          args: [fixture, provider, "normal", log],
          ...(enabled ? { contextServer } : {}),
        });
        // Snapshotting prevents a caller changing the name into a config path after validation.
        contextServer.name = "model_provider";
        contextServer.env.COD_WORKSPACE_ID = "mutated";
        contextServer.args.push("mutated");
        try {
          if (resume) await adapter.resume(`${provider}-native`);
          else await adapter.create();
          const messages = (await readFile(log, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const method =
            provider === "codex"
              ? resume
                ? "thread/resume"
                : "thread/start"
              : resume
                ? "session/load"
                : "session/new";
          const request = messages.find((message) => message.method === method);
          const expected: Record<string, unknown> = { cwd: process.cwd() };
          if (provider === "codex") {
            if (resume) expected.threadId = `${provider}-native`;
            else expected.ephemeral = false;
            if (enabled)
              expected.config = {
                "mcp_servers.cod_fixture_unique": {
                  command: process.execPath,
                  args: ["/invented/context-server.cjs"],
                  env: { COD_WORKSPACE_ID: "invented" },
                },
              };
          } else {
            if (resume) expected.sessionId = `${provider}-native`;
            expected.mcpServers = enabled
              ? [
                  {
                    name: "cod_fixture_unique",
                    command: process.execPath,
                    args: ["/invented/context-server.cjs"],
                    env: [{ name: "COD_WORKSPACE_ID", value: "invented" }],
                  },
                ]
              : [];
          }
          assert.deepEqual(request.params, expected);
        } finally {
          await adapter.dispose();
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
  }
  test(`${provider}: rejects invalid context configuration before spawning`, () => {
    const valid = {
      name: "cod_context",
      command: process.execPath,
      args: [],
      env: {},
    };
    for (const value of [
      null,
      [],
      { ...valid, name: "a.b" },
      { ...valid, name: "__proto__" },
      { ...valid, command: "node" },
      { ...valid, args: [1] },
      { ...valid, args: ["bad\0arg"] },
      { ...valid, env: { KEY: undefined } },
      { ...valid, env: { "A=B": "value" } },
      { ...valid, developerInstructions: "replace" },
    ]) {
      assert.throws(
        () =>
          (provider === "codex" ? createCodexAdapter : createKimiAdapter)({
            cwd: process.cwd(),
            executable: "/must/not/spawn",
            contextServer:
              value as unknown as import("../../src/providers/types.ts").ContextServer,
          }),
        /Invalid context server/,
      );
    }
  });
}

for (const provider of ["codex", "kimi"] as const) {
  test(`${provider}: image-only prompt crosses native subprocess protocol`, async () => {
    const { adapter } = setup(provider, "images");
    try {
      await adapter.create();
      assert.equal(
        (
          await adapter.send("", [
            { mimeType: "image/png", data: "aW52ZW50ZWQ=" },
          ])
        ).status,
        "completed",
      );
    } finally {
      await adapter.dispose();
    }
  });
}

test("Codex exposes explicit native commentary/partial/final metadata without duplicating deltas", async () => {
  const { adapter, events } = setup("codex", "phases");
  try {
    await adapter.create();
    await adapter.send("fixture phases");
    const metadata = events.filter((event) => event.type === "message-meta");
    assert.deepEqual(
      metadata.map((event) => event.phase),
      ["commentary", "commentary", "partial", "partial", "final", "final"],
    );
    assert.equal(
      metadata.find((event) => event.itemId === "partial" && event.text)
        ?.interactive,
      true,
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text),
      ["Checking files", "Progress so far", "Finished"],
    );
  } finally {
    await adapter.dispose();
  }
});
