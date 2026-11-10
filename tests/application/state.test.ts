import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ApplicationStateStore } from "../../src/application/state.ts";

test("state transactions serialize and publish only durable commits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-state-"));
  const store = new ApplicationStateStore(directory);
  try {
    await store.load();
    assert.deepEqual(store.data.workspaces, []);
    const seen: string[] = [];
    store.onDidChange = (state) => seen.push(state.activeWorkspaceId!);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.change(async () => {
      await gate;
      store.data.activeWorkspaceId = "first";
    });
    const second = store.change(() => {
      assert.equal(store.data.activeWorkspaceId, "first");
      store.data.activeWorkspaceId = "second";
    });
    release();
    await Promise.all([first, second]);
    assert.deepEqual(seen, ["first", "second"]);
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"))
        .activeWorkspaceId,
      "second",
    );
    await assert.rejects(
      store.change(() => {
        store.data.activeWorkspaceId = "failed";
        throw new Error("rejected");
      }),
    );
    assert.equal(store.data.activeWorkspaceId, "second");
    await store.change(() => {
      store.data.activeWorkspaceId = "third";
    });
    const restored = new ApplicationStateStore(directory);
    await restored.load();
    assert.equal(restored.data.activeWorkspaceId, "third");
  } finally {
    store.beginShutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted terminals never replay output or claim their old process is alive", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-state-"));
  const store = new ApplicationStateStore(directory);
  try {
    await store.load();
    store.data.terminals.push({
      id: "terminal",
      workspaceId: "workspace",
      paneId: "pane",
      cwd: directory,
      status: "running",
      pid: 42,
      output: "private output",
      sequence: 3,
      cols: 80,
      rows: 24,
    });
    await store.persist();
    const restored = new ApplicationStateStore(directory);
    await restored.load();
    assert.equal(restored.data.terminals[0]!.pid, 0);
    assert.equal(restored.data.terminals[0]!.output, "");
    assert.equal(store.data.terminals[0]!.pid, 42);
  } finally {
    store.beginShutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
