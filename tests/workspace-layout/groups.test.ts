import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertWorkspaceLayout,
  normalizeGroups,
  orderedGroups,
  revealSplit,
  selectGroup,
  showGroupOnly,
} from "../../src/workspace-layout.ts";
import type { WorkspaceState } from "../../src/types.ts";

const fixture = (): WorkspaceState => ({
  id: "w",
  name: "Task",
  folders: [],
  panes: [
    { id: "a", kind: "document", filePath: "/invented/a.md" },
    { id: "b", kind: "document", filePath: "/invented/b.md" },
  ],
  activePaneId: "a",
  groups: [{ id: "first", paneIds: ["a", "b"], activePaneId: "a" }],
  groupLayout: { type: "leaf", paneId: "first" },
  activeGroupId: "first",
});

test("material can join a canonical one-group workspace without changing its group", () => {
  const workspace = fixture();
  assertWorkspaceLayout(workspace);
  workspace.panes.push({
    id: "c",
    kind: "document",
    filePath: "/invented/c.md",
  });
  workspace.activePaneId = "c";
  normalizeGroups(workspace);
  assert.deepEqual(workspace.groups[0].paneIds, ["a", "b", "c"]);
  assert.equal(workspace.groups[0].activePaneId, "c");
  assert.deepEqual(workspace.groupLayout, { type: "leaf", paneId: "first" });
});

test("the empty side and saved width survive switching and closing its last view", () => {
  const workspace = fixture();
  revealSplit(workspace);
  assertWorkspaceLayout(workspace);
  assert.ok(workspace.groupLayout.type === "split");
  workspace.groupLayout.ratio = 0.4;
  const [left, right] = orderedGroups(workspace);
  const empty = right.activePaneId;
  assert.equal(
    workspace.panes.find((pane) => pane.id === empty)?.kind,
    "empty",
  );
  assert.equal(workspace.activeGroupId, left.id);

  showGroupOnly(workspace, left);
  selectGroup(workspace, right);
  assert.deepEqual(
    orderedGroups(workspace).map((group) => !!group.hidden),
    [true, false],
  );
  assert.equal(workspace.activePaneId, empty);
  revealSplit(workspace);
  assert.equal(workspace.groupLayout.ratio, 0.4);
  assert.equal(workspace.activePaneId, empty);

  workspace.panes = workspace.panes.filter((pane) => pane.id !== empty);
  normalizeGroups(workspace);
  assert.equal(workspace.groups.length, 2);
  assert.equal(workspace.activeGroupId, right.id);
  assert.notEqual(workspace.activePaneId, empty);
  assert.equal(workspace.groupLayout.ratio, 0.4);
});

test("new material opens to the left of chat without creating more than two groups", () => {
  const workspace = fixture();
  workspace.panes = [{ id: "a", kind: "document", draftChat: true }];
  workspace.panes.push({
    id: "spec",
    kind: "document",
    filePath: "/invented/spec.md",
  });
  workspace.activePaneId = "spec";
  normalizeGroups(workspace);
  assert.equal(workspace.groups.length, 2);
  assert.ok(workspace.groupLayout.type === "split");
  assert.equal(workspace.groupLayout.second.paneId, "first");

  workspace.panes.push({
    id: "browser",
    kind: "browser",
    browserId: "browser",
  });
  normalizeGroups(workspace);
  assert.equal(workspace.groups.length, 2);
  assert.deepEqual(orderedGroups(workspace)[0].paneIds, ["spec", "browser"]);
});

test("unsupported nested group layouts are rejected without rewriting the workspace", () => {
  const workspace = fixture();
  revealSplit(workspace);
  assert.ok(workspace.groupLayout.type === "split");
  const original = structuredClone(workspace.groupLayout);
  Object.assign(workspace.groupLayout, { first: original });
  const unsupported = structuredClone(workspace);
  assert.throws(
    () => assertWorkspaceLayout(workspace),
    /one or two side-by-side groups/,
  );
  assert.deepEqual(workspace, unsupported);
});
