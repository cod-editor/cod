import assert from "node:assert/strict";
import { test } from "node:test";
import { rollbackState } from "../../src/state-rollback.ts";
import type { AppState, ConversationState } from "../../src/types.ts";
test("failed layout operation preserves native controller identity and intervening output", () => {
  const conversation: ConversationState = {
    id: "c",
    workspaceId: "w",
    paneId: "p",
    provider: "codex",
    nativeId: "native",
    cwd: "/fixture",
    status: "working",
    messages: [],
    tools: [],
    pendingPermissions: [],
  };
  const state: AppState = {
    workspaces: [],
    activeWorkspaceId: null,
    conversations: [conversation],
    terminals: [],
    browsers: [],
    drafts: {},
  };
  const before = structuredClone(state),
    original = { ...state, conversations: [...state.conversations] };
  conversation.messages.push({
    id: "m",
    role: "assistant",
    text: "arrived during operation",
    order: 1,
  });
  conversation.completionRevision = 1;
  conversation.taskStatus = "failed";
  rollbackState(state, before, original);
  assert.equal(state.conversations[0], conversation);
  assert.equal(conversation.messages[0]!.text, "arrived during operation");
  assert.equal(conversation.taskStatus, undefined);
  assert.equal(conversation.completionRevision, 1);
});

test("failed workspace close cannot pretend an already stopped terminal is running", () => {
  const terminal = {
    id: "t",
    paneId: "p",
    workspaceId: "w",
    cwd: "/fixture",
    status: "running" as "running" | "exited",
    pid: 42,
    cols: 80,
    rows: 24,
    output: "",
    sequence: 0,
  };
  const state: AppState = {
    workspaces: [],
    activeWorkspaceId: null,
    conversations: [],
    terminals: [terminal],
    browsers: [],
    drafts: {},
  };
  const before = structuredClone(state),
    original = { ...state, terminals: [...state.terminals] };
  terminal.status = "exited";
  terminal.output = "closed";
  rollbackState(state, before, original);
  assert.equal(state.terminals[0], terminal);
  assert.equal(terminal.status, "exited");
  assert.equal(terminal.output, "closed");
});
