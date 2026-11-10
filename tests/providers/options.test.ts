import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCodexAdapter,
  createKimiAdapter,
} from "../../src/providers/index.ts";
async function setup(p: "codex" | "kimi", mode = "normal") {
  const cwd = await mkdtemp(path.join(tmpdir(), "cod-options-test-")),
    record = path.join(cwd, "record");
  const adapter = (p === "codex" ? createCodexAdapter : createKimiAdapter)({
    cwd,
    executable: process.execPath,
    args: [
      fileURLToPath(new URL("./options-fixture.mjs", import.meta.url)),
      p,
      mode,
      record,
    ],
    requestTimeoutMs: 500,
  });
  return {
    adapter,
    requests: async () =>
      (await readFile(record, "utf8"))
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x)),
    close: async () => {
      await adapter.dispose();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}
for (const p of ["codex", "kimi"] as const) {
  test(`${p} options preserve omitted defaults, validate native choices and keep modes unsupported`, async () => {
    const f = await setup(p);
    try {
      await f.adapter.create();
      assert.equal(f.adapter.capabilities.modeSelection, false);
      const o = await f.adapter.getOptions();
      assert.equal(o.models.length, 2);
      await assert.rejects(
        f.adapter.setOption({ option: "model", value: "arbitrary" }),
      );
      await f.adapter.send("plain");
      const request = (await f.requests()).find(
        (m) => m.method === (p === "codex" ? "turn/start" : "session/prompt"),
      );
      assert.equal(request.params.model, undefined);
      assert.equal(request.params.effort, undefined);
    } finally {
      await f.close();
    }
  });
  test(`${p} malformed catalog fails explicitly without manufacturing choices`, async () => {
    const f = await setup(p, "malformed");
    try {
      await f.adapter.create();
      await assert.rejects(f.adapter.getOptions());
    } finally {
      await f.close();
    }
  });
}
test("Codex paginates, stages explicit choice, clears incompatible effort, and sends only requested overrides", async () => {
  const f = await setup("codex");
  try {
    await f.adapter.resume("invented-session");
    await f.adapter.setOption({ option: "reasoning", value: "low" });
    const state = await f.adapter.setOption({
      option: "model",
      value: "native-b",
    });
    assert.equal(state.current.model, "native-a");
    assert.deepEqual(state.pending, { model: "native-b" });
    assert.equal(state.selectionEffect, "next-turn");
    await f.adapter.send("chosen");
    const request = (await f.requests()).find((m) => m.method === "turn/start");
    assert.equal(request.params.model, "native-b");
    assert.equal(request.params.effort, undefined);
  } finally {
    await f.close();
  }
});
test("Codex rejects repeated pagination and queues send behind options discovery", async () => {
  const bad = await setup("codex", "repeat");
  try {
    await bad.adapter.create();
    await assert.rejects(bad.adapter.getOptions());
  } finally {
    await bad.close();
  }
  const f = await setup("codex", "delay");
  try {
    await f.adapter.create();
    const pending = f.adapter.getOptions();
    const turn = f.adapter.send("race");
    await pending;
    assert.equal((await turn).status, "completed");
    const methods = (await f.requests()).map((request) => request.method);
    assert.equal(methods.filter((method) => method === "turn/start").length, 1);
    assert.ok(
      methods.lastIndexOf("model/list") < methods.indexOf("turn/start"),
    );
  } finally {
    await f.close();
  }
});
test("Kimi selection is native acknowledged and foreign-session updates cannot replace it", async () => {
  const f = await setup("kimi");
  try {
    await f.adapter.create();
    const state = await f.adapter.setOption({
      option: "model",
      value: "native-b",
    });
    assert.equal(state.current.model, "native-b");
    assert.equal(state.selectionEffect, "immediate");
    assert.equal((await f.adapter.getOptions()).current.model, "native-b");
    const req = (await f.requests()).find(
      (m) => m.method === "session/set_config_option",
    );
    assert.deepEqual(req.params, {
      sessionId: "invented-session",
      configId: "model",
      value: "native-b",
    });
  } finally {
    await f.close();
  }
});
test("Kimi rejection never reports requested selection as applied", async () => {
  const f = await setup("kimi", "reject");
  try {
    await f.adapter.create();
    await assert.rejects(
      f.adapter.setOption({ option: "model", value: "native-b" }),
    );
    await assert.rejects(f.adapter.getOptions(), /unavailable|reconnect/i);
  } finally {
    await f.close();
  }
});

test("invalid option shapes and disposed adapters report stable safe error codes", async () => {
  const f = await setup("kimi");
  try {
    await assert.rejects(f.adapter.getOptions(), { code: "not-ready" });
    await f.adapter.create();
    await assert.rejects(
      f.adapter.setOption({ option: "mode", value: "plan" } as never),
      { code: "invalid-selection" },
    );
    await assert.rejects(
      f.adapter.setOption({ option: "reasoning", value: "unsupported" }),
      { code: "invalid-selection" },
    );
    await f.adapter.dispose();
    await assert.rejects(f.adapter.getOptions(), { code: "not-ready" });
  } finally {
    await f.close();
  }
});

test("Codex rejected start never changes returned native confirmation and does not mutate pending snapshot", async () => {
  const f = await setup("codex", "reject");
  try {
    await f.adapter.create();
    const selected = await f.adapter.setOption({
      option: "model",
      value: "native-b",
    });
    await assert.rejects(f.adapter.send("rejected"));
    assert.equal(selected.current.model, "native-a");
    assert.equal(selected.pending?.model, "native-b");
    const request = (await f.requests()).find((m) => m.method === "turn/start");
    assert.equal(request.params.model, "native-b");
  } finally {
    await f.close();
  }
});

for (const action of ["dispose", "cancel"] as const) {
  test(`Codex ${action} prevents inference queued behind metadata`, async () => {
    const f = await setup("codex", "delay");
    try {
      await f.adapter.create();
      const options = f.adapter.getOptions().catch(() => undefined);
      const turn = f.adapter.send("must not run");
      const outcome =
        action === "dispose"
          ? assert.rejects(turn, /disposed|closed/i)
          : turn.then((result) => assert.equal(result.status, "cancelled"));
      await f.adapter[action]();
      await Promise.all([options, outcome]);
      assert.equal(
        (await f.requests()).some((request) => request.method === "turn/start"),
        false,
      );
    } finally {
      await f.close();
    }
  });
}
