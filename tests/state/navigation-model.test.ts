import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectNavigation,
  visibleNavigation,
} from "../../src/ui/navigation-model.ts";
import type { AppState } from "../../src/types";

function fixture(): AppState {
  return {
    activeWorkspaceId: "alpha",
    drafts: {},
    terminals: [],
    workspaces: [
      {
        id: "alpha",
        name: "Invented Alpha",
        folders: [],
        activePaneId: "pane-a",
        panes: [
          {
            kind: "conversation",
            id: "pane-a",
            conversationId: "chat-a",
            pinned: true,
          },
        ],
        groups: [{ id: "group", paneIds: ["pane-a"], activePaneId: "pane-a" }],
        groupLayout: { type: "leaf", paneId: "group" },
        activeGroupId: "group",
      },
      {
        id: "beta",
        name: "Invented Beta",
        folders: [],
        activePaneId: "pane-b",
        panes: [{ kind: "browser", id: "pane-b", browserId: "browser-b" }],
        groups: [{ id: "group", paneIds: ["pane-b"], activePaneId: "pane-b" }],
        groupLayout: { type: "leaf", paneId: "group" },
        activeGroupId: "group",
      },
    ],
    conversations: [
      {
        id: "chat-a",
        workspaceId: "alpha",
        paneId: "pane-a",
        displayName: "Shared complete label",
        status: "ready",
        provider: "codex",
        nativeId: "invented-native",
        cwd: "/invented",
        messages: [],
        tools: [],
        pendingPermissions: [],
        completionRevision: 2,
        acknowledgedCompletionRevision: 1,
      },
    ],
    browsers: [
      {
        id: "browser-b",
        paneId: "pane-b",
        workspaceId: "beta",
        title: "Shared complete label",
        url: "https://example.test/needle",
        loading: false,
        visible: false,
        canGoBack: false,
        canGoForward: false,
      },
    ],
  };
}

test("Navigation shares full labels, attention and pin identities without retaining conversation payloads", () => {
  const state = fixture();
  Object.defineProperty(state.conversations[0], "messages", {
    get() {
      throw new Error(
        "Named navigation must not read retained transcript payloads",
      );
    },
  });
  const items = projectNavigation(state);
  assert.deepEqual(
    items.map((item) => item.key),
    [
      "workspace:alpha",
      "conversation:chat-a",
      "workspace:beta",
      "browser:browser-b",
    ],
  );
  assert.equal(items[0].status, "ready");
  assert.equal(items[1].active, true);
  assert.equal(items[1].pinned, true);
  assert.equal(items[1].label, "Shared complete label");
  assert.equal("messages" in items[1], false);
  state.conversations[0].acknowledgedCompletionRevision = 2;
  assert.equal(projectNavigation(state)[0].status, "");
  state.conversations[0].status = "waiting";
  assert.equal(projectNavigation(state)[0].status, "waiting");
});

test("Working overrides older completion while approvals, reviews and failures retain priority", () => {
  const state = fixture();
  const chat = state.conversations[0];
  const statuses = () =>
    projectNavigation(state)
      .slice(0, 2)
      .map((item) => item.status);
  chat.taskStatus = "ready";
  chat.taskStatusUpdatedAt = "2026-01-01T10:00:00Z";
  chat.taskStatusContext = "The previous export completed";
  assert.deepEqual(statuses(), ["ready", "ready"]);

  chat.status = "working";
  assert.deepEqual(statuses(), ["working", "working"]);
  assert.equal(projectNavigation(state)[1].context, undefined);
  chat.taskStatusAcknowledgedAt = chat.taskStatusUpdatedAt;
  chat.acknowledgedCompletionRevision = chat.completionRevision;
  assert.deepEqual(statuses(), ["working", "working"]);

  for (const taskStatus of ["failed", "waiting", "review"] as const) {
    chat.taskStatus = taskStatus;
    assert.deepEqual(statuses(), [taskStatus, taskStatus]);
  }

  chat.taskStatus = "ready";
  chat.status = "ready";
  assert.deepEqual(statuses(), ["", ""]);
  chat.completionRevision = 3;
  assert.deepEqual(statuses(), ["ready", "ready"]);
  assert.equal(projectNavigation(state)[1].context, undefined);
});

test("Search includes ownership and URL context while preserving unfiltered grouping", () => {
  const items = projectNavigation(fixture());
  assert.deepEqual(
    visibleNavigation(items, "").map((item) => item.key),
    [
      "workspace:alpha",
      "conversation:chat-a",
      "workspace:beta",
      "browser:browser-b",
    ],
  );
  assert.deepEqual(
    visibleNavigation(items, "beta shared").map((item) => item.key),
    ["workspace:beta", "browser:browser-b"],
  );
  assert.deepEqual(
    visibleNavigation(items, "needle").map((item) => item.key),
    ["workspace:beta", "browser:browser-b"],
  );
  assert.deepEqual(
    visibleNavigation(items, "alpha").map((item) => item.key),
    ["workspace:alpha", "conversation:chat-a"],
  );
  assert.deepEqual(visibleNavigation(items, "missing"), []);
});

test("An unlisted active review falls back to its workspace and browser loading is not agent attention", () => {
  const state = fixture();
  state.workspaces[0].panes.push({
    kind: "review",
    id: "unlisted-review-pane",
    reviewId: "acknowledged-review",
  });
  state.workspaces[0].activePaneId = "unlisted-review-pane";
  state.browsers[0].loading = true;
  state.browsers[0].error = "Invented navigation failure";
  const items = projectNavigation(state);
  assert.equal(items[0].active, true);
  assert.equal(items.find((item) => item.kind === "browser")?.status, "");
  assert.match(
    items.find((item) => item.kind === "browser")!.hint!,
    /Invented navigation failure/,
  );
  assert.deepEqual(
    visibleNavigation(items, "no match", "conversation:chat-a").map(
      (item) => item.key,
    ),
    ["workspace:alpha", "conversation:chat-a"],
  );
});

test("Overview groups terminal metadata and pending reviews without requiring an open review pane", () => {
  const state = fixture();
  state.workspaces[0].panes.push({
    kind: "terminal",
    id: "terminal-pane",
    terminalId: "terminal-one",
  });
  state.terminals.push({
    id: "terminal-one",
    paneId: "terminal-pane",
    workspaceId: "alpha",
    cwd: "/invented/project shell",
    status: "running",
    pid: 123,
    cols: 80,
    rows: 24,
    output: "",
    sequence: 1,
  });
  Object.defineProperty(state.terminals[0], "output", {
    get() {
      throw new Error("Navigation must not read PTY output");
    },
  });
  state.reviews = [
    {
      id: "review-one",
      workspaceId: "alpha",
      originConversationId: "chat-a",
      target: { kind: "document", path: "/invented/detailed-spec.md" },
      currentRoundId: "round-one",
      status: "draft",
      rounds: [{ id: "round-one", status: "draft" }],
    },
  ] as AppState["reviews"];
  state.workspaces[0].activePaneId = "terminal-pane";
  const overview = projectNavigation(state);
  const review = overview.find((item) => item.kind === "review")!;
  assert.equal(review.parent, "workspace:alpha");
  assert.equal(review.status, "review");
  assert.equal(review.paneId, undefined);
  const terminal = overview.find((item) => item.kind === "terminal")!;
  assert.equal(terminal.parent, "workspace:alpha");
  assert.equal(terminal.active, true);
  assert.equal(terminal.status, "running");
  assert.equal(terminal.hint, "/invented/project shell");
  assert.equal("output" in terminal, false);
  assert.deepEqual(
    visibleNavigation(overview, "alpha project").map((item) => item.key),
    ["workspace:alpha", "terminal:terminal-one"],
  );
  assert.deepEqual(
    visibleNavigation(overview, "alpha").map((item) => item.key),
    [
      "workspace:alpha",
      "conversation:chat-a",
      "terminal:terminal-one",
      "review:review-one",
    ],
  );
  state.terminals = [];
  assert.equal(projectNavigation(state)[0].active, true);
});

test("Overview hides only cancelled reviews without an open tab or pending delivery", () => {
  const state = fixture();
  const target = { kind: "document", path: "/invented/review.md" };
  state.reviews = [
    { id: "past", status: "cancelled", rounds: [] },
    { id: "open", status: "cancelled", rounds: [] },
    {
      id: "pending",
      status: "cancelled",
      rounds: [{ submission: { delivery: { status: "queued" } } }],
    },
    { id: "draft", status: "draft", rounds: [] },
  ].map((review) => ({
    ...review,
    workspaceId: "alpha",
    target,
  })) as AppState["reviews"];
  state.workspaces[0].panes.push({
    kind: "review",
    id: "open-pane",
    reviewId: "open",
  });

  const reviews = (includeClosed: boolean) =>
    projectNavigation(state, includeClosed).filter(
      (item) => item.kind === "review",
    );
  assert.deepEqual(
    reviews(false).map((item) => item.id),
    ["open", "pending", "draft"],
  );
  assert.deepEqual(
    reviews(true).map((item) => item.id),
    ["past", "open", "pending", "draft"],
  );
  assert.equal(reviews(true)[0].closed, undefined);
});
