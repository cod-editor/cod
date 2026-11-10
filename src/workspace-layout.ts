import { randomUUID } from "node:crypto";
import type { Layout, WorkspaceState } from "./types";

export function normalizeGroups(workspace: WorkspaceState): void {
  const ids = new Set(workspace.panes.map((pane) => pane.id));
  if (!workspace.groups?.length) {
    const id = randomUUID();
    workspace.groups = [
      { id, paneIds: [...ids], activePaneId: workspace.activePaneId },
    ];
    workspace.groupLayout = { type: "leaf", paneId: id };
    workspace.activeGroupId = id;
  }
  const seen = new Set<string>();
  for (const group of workspace.groups) {
    group.paneIds = group.paneIds.filter(
      (id) => ids.has(id) && !seen.has(id) && !!seen.add(id),
    );
  }
  const active =
    workspace.groups.find((group) => group.id === workspace.activeGroupId) ??
    workspace.groups[0]!;
  const isChat = (id: string) => {
    const pane = workspace.panes.find((item) => item.id === id);
    return (
      pane?.kind === "conversation" ||
      pane?.kind === "terminal" ||
      (pane?.kind === "document" && !pane.filePath)
    );
  };
  for (const id of ids)
    if (!seen.has(id)) {
      const chat = isChat(id);
      let destination = workspace.groups.find((group) =>
        group.paneIds.some((other) => isChat(other) === chat),
      );
      if (!destination) {
        destination = { id: randomUUID(), paneIds: [], activePaneId: id };
        workspace.groups.push(destination);
        const next: Layout = { type: "leaf", paneId: destination.id };
        workspace.groupLayout = {
          type: "split",
          direction: "right",
          ratio: 0.5,
          first: chat ? workspace.groupLayout! : next,
          second: chat ? next : workspace.groupLayout!,
        };
        workspace.zoomedGroupId = null;
      }
      destination.paneIds.push(id);
      destination.hidden = false;
    }
  for (const group of workspace.groups) {
    if (group.paneIds.length < 2) continue;
    const emptyIds = group.paneIds.filter((id) =>
      workspace.panes.some((pane) => pane.id === id && pane.kind === "empty"),
    );
    if (emptyIds.length === group.paneIds.length) continue;
    for (const id of emptyIds) {
      ids.delete(id);
      workspace.panes = workspace.panes.filter((pane) => pane.id !== id);
      group.paneIds = group.paneIds.filter((paneId) => paneId !== id);
      workspace.layout = removeGroup(workspace.layout, id) ?? {
        type: "leaf",
        paneId: group.paneIds[0]!,
      };
    }
  }
  for (const group of [...workspace.groups]) {
    if (!group.paneIds.length && workspace.groups.length > 1) {
      workspace.groups = workspace.groups.filter((item) => item !== group);
      workspace.groupLayout = removeGroup(workspace.groupLayout!, group.id) ?? {
        type: "leaf",
        paneId: active.id,
      };
    } else if (!group.paneIds.includes(group.activePaneId))
      group.activePaneId = group.paneIds[0] ?? "";
  }
  if (!ids.has(workspace.activePaneId))
    workspace.activePaneId =
      workspace.groups.find((group) => !group.hidden)?.activePaneId ??
      workspace.groups[0]!.activePaneId;
  const owner = workspace.groups.find((group) =>
    group.paneIds.includes(workspace.activePaneId),
  );
  if (owner) {
    owner.activePaneId = workspace.activePaneId;
    owner.hidden = false;
    if (workspace.zoomedGroupId && workspace.zoomedGroupId !== owner.id)
      workspace.zoomedGroupId = null;
    workspace.activeGroupId = owner.id;
  }
  if (!workspace.groups.some((group) => group.id === workspace.zoomedGroupId))
    workspace.zoomedGroupId = null;
  if (workspace.groups.every((group) => group.hidden))
    workspace.groups[0]!.hidden = false;
}

export function replaceGroup(
  layout: Layout,
  id: string,
  replacement: Layout,
): Layout {
  if (layout.type === "leaf")
    return layout.paneId === id ? replacement : layout;
  return {
    ...layout,
    first: replaceGroup(layout.first, id, replacement),
    second: replaceGroup(layout.second, id, replacement),
  };
}
export function removeGroup(layout: Layout, id: string): Layout | null {
  if (layout.type === "leaf") return layout.paneId === id ? null : layout;
  const first = removeGroup(layout.first, id),
    second = removeGroup(layout.second, id);
  return first && second ? { ...layout, first, second } : (first ?? second);
}
