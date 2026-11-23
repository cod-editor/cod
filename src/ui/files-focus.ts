import type { AppState } from "../types";
import type { Invoke } from "./contracts";
import type { createFocusManager } from "./focus";
import type { createKeyboardNavigation } from "./keyboard-navigation";

export function createFilesFocusToggle(
  getState: () => AppState,
  invoke: Invoke,
  focus: ReturnType<typeof createFocusManager>,
  keys: ReturnType<typeof createKeyboardNavigation>,
) {
  const returns = new Map<string, ReturnType<typeof focus.capture>>();
  const pending = new Map<
    string,
    { promise: Promise<void>; intent: AbortController }
  >();
  const workspace = () =>
    getState().workspaces.find((w) => w.id === getState().activeWorkspaceId);
  async function restore(
    origin: ReturnType<typeof focus.capture>,
    intent: AbortController,
  ) {
    const browser = origin.browserId
      ? getState().browsers.find((b) => b.id === origin.browserId)
      : undefined;
    const id = browser?.paneId ?? origin.paneId ?? origin.tabId;
    const owner = id
      ? getState().workspaces.find((w) => w.panes.some((p) => p.id === id))
      : undefined;
    if (
      owner &&
      id &&
      !origin.element &&
      !origin.label &&
      !origin.browserId &&
      !origin.tabId
    ) {
      await keys.focusPane(id, intent);
      return;
    }
    if (owner && id) await invoke("pane.focus", { workspace: owner.id, id });
    if (
      await keys.whenRendered(() => {
        if (owner && workspace()?.id !== owner.id) return false;
        return owner && id
          ? workspace()?.activePaneId === id || undefined
          : true;
      }, intent.signal)
    )
      focus.restore(origin);
  }
  async function performToggle(
    requestedWorkspace: string,
    intent: AbortController,
  ): Promise<void> {
    // Accepted state can still be awaiting its batched DOM render. Capture both
    // the destination and return control after that frame, never from an old tree.
    if (
      !(await keys.whenRendered(
        () => workspace()?.id === requestedWorkspace,
        intent.signal,
      ))
    )
      return;
    const w = workspace();
    if (!w) return;
    const within = !!document.activeElement?.closest("#project-panel");
    const key = w.id;
    const origin = returns.get(key);
    if (within && origin) {
      returns.delete(key);
      await restore(origin, intent);
      return;
    }
    if (!within) {
      const captured = focus.capture();
      const browser = getState().browsers.find(
        (browser) => browser.id === captured.browserId,
      );
      const originId = browser?.paneId ?? captured.paneId ?? captured.tabId;
      const originWorkspace = originId
        ? getState().workspaces.find((workspace) =>
            workspace.panes.some((pane) => pane.id === originId),
          )
        : undefined;
      returns.set(
        key,
        originWorkspace && originWorkspace.id !== w.id
          ? { paneId: w.activePaneId }
          : captured,
      );
    }
    if (w.settings?.filesVisible !== true) {
      await invoke("workspace.settings", {
        id: w.id,
        settings: { filesVisible: true },
      });
      if (
        !(await keys.whenRendered(
          () =>
            workspace()?.id !== w.id
              ? false
              : workspace()?.settings?.filesVisible === true || undefined,
          intent.signal,
        ))
      )
        return;
    }
    const host = document.querySelector<HTMLElement>("#project-panel");
    (
      host?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ??
      host?.querySelector<HTMLElement>('[role="treeitem"]') ??
      host
    )?.focus();
  }
  return function toggleFilesFocus(intent = keys.beginFocus()): Promise<void> {
    const key = workspace()?.id;
    if (!key) return Promise.resolve();
    const existing = pending.get(key);
    if (existing && !existing.intent.signal.aborted) return existing.promise;
    const action = performToggle(key, intent).finally(() => {
      if (pending.get(key)?.promise === action) pending.delete(key);
    });
    pending.set(key, { promise: action, intent });
    return action;
  };
}
