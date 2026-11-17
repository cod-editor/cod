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
        layout: { type: "leaf", paneId: "pane-a" },
      },
      {
        id: "beta",
        name: "Invented Beta",
        folders: [],
        activePaneId: "pane-b",
        panes: [{ kind: "browser", id: "pane-b", browserId: "browser-b" }],
        layout: { type: "leaf", paneId: "pane-b" },
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

test("Search includes ownership and URL context while preserving unfiltered expansion", () => {
  const items = projectNavigation(fixture());
  const collapsed = new Set(["workspace:beta"]);
  assert.deepEqual(
    visibleNavigation(items, "", collapsed).map((item) => item.key),
    ["workspace:alpha", "conversation:chat-a", "workspace:beta"],
  );
  assert.deepEqual(
    visibleNavigation(items, "beta shared", collapsed).map((item) => item.key),
    ["workspace:beta", "browser:browser-b"],
  );
  assert.deepEqual(
    visibleNavigation(items, "needle", collapsed).map((item) => item.key),
    ["workspace:beta", "browser:browser-b"],
  );
  assert.deepEqual(
    visibleNavigation(items, "alpha", collapsed).map((item) => item.key),
    ["workspace:alpha", "conversation:chat-a"],
  );
  assert.equal(collapsed.has("workspace:beta"), true);
  assert.deepEqual(visibleNavigation(items, "missing", collapsed), []);
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
    visibleNavigation(items, "no match", new Set(), "conversation:chat-a").map(
      (item) => item.key,
    ),
    ["workspace:alpha", "conversation:chat-a"],
  );
});

test("Overview groups terminal metadata with chats and pages while the sidebar retains its review tree", () => {
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
      rounds: [{ id: "round-one", status: "draft" }],
    },
  ] as AppState["reviews"];
  state.workspaces[0].panes.push({
    kind: "review",
    id: "review-pane",
    reviewId: "review-one",
  });
  state.workspaces[0].activePaneId = "terminal-pane";
  const sidebar = projectNavigation(state),
    overview = projectNavigation(state, "overview");
  assert(
    sidebar.some(
      (item) => item.kind === "review" && item.parent === "conversation:chat-a",
    ),
  );
  assert(!sidebar.some((item) => item.kind === "terminal"));
  assert(!overview.some((item) => item.kind === "review"));
  const terminal = overview.find((item) => item.kind === "terminal")!;
  assert.equal(terminal.parent, "workspace:alpha");
  assert.equal(terminal.active, true);
  assert.equal(terminal.status, "running");
  assert.equal(terminal.hint, "/invented/project shell");
  assert.equal("output" in terminal, false);
  assert.deepEqual(
    visibleNavigation(overview, "alpha project", new Set()).map(
      (item) => item.key,
    ),
    ["workspace:alpha", "terminal:terminal-one"],
  );
  assert.deepEqual(
    visibleNavigation(overview, "alpha", new Set()).map((item) => item.key),
    ["workspace:alpha", "conversation:chat-a", "terminal:terminal-one"],
  );
  state.terminals = [];
  assert.equal(projectNavigation(state, "overview")[0].active, true);
});
