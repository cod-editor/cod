import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeGroups, replaceGroup } from "../../src/workspace-layout.ts";
import type { WorkspaceState } from "../../src/types.ts";
const fixture = (): WorkspaceState => ({
  id: "w",
  name: "Task",
  folders: [],
  panes: [
    { id: "a", kind: "document" },
    { id: "b", kind: "document" },
  ],
  activePaneId: "a",
  layout: { type: "leaf", paneId: "a" },
});
test("legacy workspace migrates once; newly opened material joins active group", () => {
  const workspace = fixture();
  normalizeGroups(workspace);
  const id = workspace.groups![0]!.id;
  workspace.panes.push({ id: "c", kind: "document" });
  workspace.activePaneId = "c";
  normalizeGroups(workspace);
  assert.equal(workspace.groups![0]!.id, id);
  assert.deepEqual(workspace.groups![0]!.paneIds, ["a", "b", "c"]);
  assert.equal(workspace.groups![0]!.activePaneId, "c");
  assert.deepEqual(JSON.parse(JSON.stringify(workspace)).groupLayout, {
    type: "leaf",
    paneId: id,
  });
});
test("closing last view in one split collapses that group and recovers active view", () => {
  const workspace = fixture();
  normalizeGroups(workspace);
  const first = workspace.groups![0]!;
  first.paneIds = ["a"];
  workspace.groups!.push({ id: "second", paneIds: ["b"], activePaneId: "b" });
  workspace.groupLayout = replaceGroup(workspace.groupLayout!, first.id, {
    type: "split",
    direction: "right",
    ratio: 0.4,
    first: workspace.groupLayout!,
    second: { type: "leaf", paneId: "second" },
  });
  workspace.panes = workspace.panes.filter((pane) => pane.id !== "b");
  workspace.activePaneId = "b";
  workspace.zoomedGroupId = "second";
  normalizeGroups(workspace);
  assert.equal(workspace.groups!.length, 1);
  assert.equal(workspace.activePaneId, "a");
  assert.equal(workspace.zoomedGroupId, null);
  assert.deepEqual(workspace.groupLayout, { type: "leaf", paneId: first.id });
});

test("new material opens left of chat while subsequent material stays in its group", () => {
  const workspace = fixture();
  workspace.panes = [{ id: "a", kind: "document", draftChat: true }];
  normalizeGroups(workspace);
  const chatGroup = workspace.groups![0]!.id;
  workspace.panes.push({
    id: "spec",
    kind: "document",
    filePath: "/invented/spec.md",
  });
  workspace.activePaneId = "spec";
  normalizeGroups(workspace);
  assert.equal(workspace.groups!.length, 2);
  assert.equal(workspace.groupLayout!.type, "split");
  const split = workspace.groupLayout!;
  assert.ok(split.type === "split");
  assert.deepEqual(split.second, { type: "leaf", paneId: chatGroup });
  workspace.panes.push({
    id: "browser",
    kind: "browser",
    browserId: "browser",
  });
  normalizeGroups(workspace);
  assert.equal(workspace.groups!.length, 2);
  assert.ok(
    workspace
      .groups!.find((group) => group.paneIds.includes("spec"))!
      .paneIds.includes("browser"),
  );
});
