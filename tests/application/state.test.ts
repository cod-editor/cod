import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ApplicationStateStore } from "../../src/application/state.ts";
import { readWorkspaceState } from "../support/workspace-state.ts";

test("state transactions serialize and publish only durable commits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-state-"));
  const store = new ApplicationStateStore(directory);
  const restored = new ApplicationStateStore(directory);
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
    assert.equal(readWorkspaceState(directory).activeWorkspaceId, "second");
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
    await restored.load();
    assert.equal(restored.data.activeWorkspaceId, "third");
  } finally {
    store.beginShutdown();
    await Promise.all([store.close(), restored.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted terminals never replay output or claim their old process is alive", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-state-"));
  const store = new ApplicationStateStore(directory);
  const restored = new ApplicationStateStore(directory);
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
    await restored.load();
    assert.equal(restored.data.terminals[0]!.pid, 0);
    assert.equal(restored.data.terminals[0]!.output, "");
    assert.equal(store.data.terminals[0]!.pid, 42);
  } finally {
    store.beginShutdown();
    await Promise.all([store.close(), restored.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("closed chat history is loaded on demand and survives archiving its workspace", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-state-"));
  const store = new ApplicationStateStore(directory);
  const restored = new ApplicationStateStore(directory);
  try {
    const pane = {
      id: "closed",
      kind: "conversation",
      conversationId: "chat",
    } as const;
    const conversation = {
      id: pane.conversationId,
      workspaceId: "workspace",
      paneId: pane.id,
      provider: "codex",
      nativeId: "saved-native-id",
      cwd: directory,
      status: "ready",
      messages: [
        { id: "message", role: "user", text: "retained history", order: 0 },
      ],
      tools: [],
      pendingPermissions: [],
    } as const;
    await store.load();
    await store.change(() => {
      store.data.activeWorkspaceId = "workspace";
      store.data.workspaces.push({
        id: "workspace",
        name: "Fixture",
        folders: [],
        panes: [{ id: "empty", kind: "document", draftChat: true }],
        activePaneId: "empty",
        groups: [{ id: "group", paneIds: ["empty"], activePaneId: "empty" }],
        groupLayout: { type: "leaf", paneId: "group" },
        activeGroupId: "group",
        closedTabs: [
          {
            pane,
            conversation: {
              ...conversation,
              messages: [...conversation.messages],
              tools: [],
              pendingPermissions: [],
            },
          },
        ],
      });
    });
    assert.equal(
      store.snapshot(true).workspaces[0]!.closedTabs![0]!.conversation,
      undefined,
    );
    assert.deepEqual(
      (await store.fullSnapshot()).workspaces[0]!.closedTabs![0]!.conversation,
      conversation,
    );
    await store.close();

    await restored.load();
    const workspace = restored.data.workspaces[0]!;
    assert.equal(workspace.closedTabs![0]!.conversation, undefined);
    await restored.change(async () => {
      restored.data.closedWorkspaces = [
        {
          workspace: await restored.workspaceWithClosedChats(workspace),
          browsers: [],
          conversations: [],
          terminals: [],
        },
      ];
      restored.data.workspaces = [];
      restored.data.activeWorkspaceId = null;
    });
    assert.deepEqual(
      (await restored.archivedWorkspace())!.workspace.closedTabs![0]!
        .conversation,
      conversation,
    );
    assert.equal(
      readWorkspaceState(directory).closedWorkspaces![0]!.workspace
        .closedTabs![0]!.conversation?.nativeId,
      conversation.nativeId,
    );
  } finally {
    await Promise.all([store.close(), restored.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});
