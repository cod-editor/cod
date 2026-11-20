import type { GroupLeaf, PaneState, TabGroup, WorkspaceState } from "./types";

export const groupLeaf = (id: string): GroupLeaf => ({
  type: "leaf",
  paneId: id,
});

export function tabGroup(pane: PaneState): TabGroup {
  return {
    id: crypto.randomUUID(),
    paneIds: [pane.id],
    activePaneId: pane.id,
  };
}

export function orderedGroups(
  workspace: Pick<WorkspaceState, "groups" | "groupLayout">,
): TabGroup[] {
  const { groupLayout, groups } = workspace;
  const ids =
    groupLayout.type === "leaf"
      ? [groupLayout.paneId]
      : [groupLayout.first.paneId, groupLayout.second.paneId];
  return ids.map((id) => groups.find((group) => group.id === id)!);
}

export function assertWorkspaceLayout(workspace: WorkspaceState): void {
  const { groupLayout, groups } = workspace;
  const ids =
    groupLayout?.type === "leaf"
      ? [groupLayout.paneId]
      : groupLayout?.type === "split" &&
          groupLayout.direction === "right" &&
          groupLayout.first?.type === "leaf" &&
          groupLayout.second?.type === "leaf" &&
          typeof groupLayout.ratio === "number" &&
          groupLayout.ratio > 0 &&
          groupLayout.ratio < 1
        ? [groupLayout.first.paneId, groupLayout.second.paneId]
        : [];
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    !Array.isArray(groups) ||
    groups.length !== ids.length ||
    ids.some((id) => !groups.some((group) => group.id === id)) ||
    !ids.includes(workspace.activeGroupId)
  )
    throw new Error("Workspace must contain one or two side-by-side groups");
}

export function revealSplit(workspace: WorkspaceState): void {
  if (workspace.groupLayout.type === "leaf") {
    const empty: PaneState = { id: crypto.randomUUID(), kind: "empty" };
    workspace.panes.push(empty);
    const group = tabGroup(empty);
    workspace.groups.push(group);
    workspace.groupLayout = {
      type: "split",
      direction: "right",
      ratio: 0.5,
      first: workspace.groupLayout,
      second: groupLeaf(group.id),
    };
  }
  for (const group of workspace.groups) group.hidden = false;
}

export function showGroupOnly(
  workspace: WorkspaceState,
  group: TabGroup,
): void {
  workspace.activeGroupId = group.id;
  workspace.activePaneId = group.activePaneId;
  for (const item of workspace.groups) item.hidden = item !== group;
}

export function selectGroup(workspace: WorkspaceState, group: TabGroup): void {
  if (workspace.groups.some((item) => item.hidden))
    showGroupOnly(workspace, group);
  workspace.activeGroupId = group.id;
  workspace.activePaneId = group.activePaneId;
}

const isChat = (pane: PaneState) =>
  pane.kind === "conversation" ||
  pane.kind === "terminal" ||
  (pane.kind === "document" && !pane.filePath);

export function normalizeGroups(workspace: WorkspaceState): void {
  const tabs = new Map(workspace.panes.map((pane) => [pane.id, pane]));
  const seen = new Set<string>();
  const active = workspace.groups.find(
    (group) => group.id === workspace.activeGroupId,
  )!;
  for (const group of workspace.groups)
    group.paneIds = group.paneIds.filter(
      (id) => tabs.has(id) && !seen.has(id) && !!seen.add(id),
    );

  for (const pane of tabs.values()) {
    if (seen.has(pane.id)) continue;
    const chat = isChat(pane);
    const sides = orderedGroups(workspace);
    const preferred = (chat ? [...sides].reverse() : sides).find((group) =>
      group.paneIds.some((id) => isChat(tabs.get(id)!) === chat),
    );
    if (preferred || sides.length === 2 || !active.paneIds.length) {
      (preferred ?? sides[chat ? sides.length - 1 : 0]).paneIds.push(pane.id);
      continue;
    }
    const newGroup = tabGroup(pane);
    workspace.groups.push(newGroup);
    const first = workspace.groupLayout as GroupLeaf;
    const second = groupLeaf(newGroup.id);
    workspace.groupLayout = {
      type: "split",
      direction: "right",
      ratio: 0.5,
      first: chat ? first : second,
      second: chat ? second : first,
    };
  }

  for (const group of workspace.groups) {
    const real = group.paneIds.filter((id) => {
      const pane = tabs.get(id)!;
      return pane.kind !== "empty" || pane.launcher || pane.pinned;
    });
    if (real.length) {
      const removed = group.paneIds.filter((id) => !real.includes(id));
      for (const id of removed) tabs.delete(id);
      group.paneIds = real;
    }
    if (!group.paneIds.length) {
      const empty: PaneState = { id: crypto.randomUUID(), kind: "empty" };
      tabs.set(empty.id, empty);
      group.paneIds.push(empty.id);
    }
    group.paneIds = [
      ...group.paneIds.filter((id) => tabs.get(id)?.pinned),
      ...group.paneIds.filter((id) => !tabs.get(id)?.pinned),
    ];
    if (!group.paneIds.includes(group.activePaneId))
      group.activePaneId = group.paneIds[0];
  }

  workspace.panes = [...tabs.values()];
  const owner =
    workspace.groups.find((group) =>
      group.paneIds.includes(workspace.activePaneId),
    ) ?? active;
  if (owner.paneIds.includes(workspace.activePaneId))
    owner.activePaneId = workspace.activePaneId;
  selectGroup(workspace, owner);
}
