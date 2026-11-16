import type { WorkspaceState } from "./types";

/** Keep moves inside the tab's segment without changing its pin state. */
export function tabInsertionIndex(
  workspace: WorkspaceState,
  ids: string[],
  id: string,
  index: number,
): number {
  const pins = ids.filter(
    (other) => workspace.panes.find((pane) => pane.id === other)?.pinned,
  ).length;
  return workspace.panes.find((pane) => pane.id === id)?.pinned
    ? Math.min(index, pins)
    : Math.max(index, pins);
}
