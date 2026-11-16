import type { AppState, PaneState, WorkspaceState } from "../types";
import type { Invoke } from "./contracts";
import type { createFocusManager } from "./focus";
import type { createKeyboardNavigation } from "./keyboard-navigation";

type Target = "files" | "workspaces" | "chat" | "terminal";
export function createFocusTargets(
  getState: () => AppState,
  invoke: Invoke,
  focus: ReturnType<typeof createFocusManager>,
  keys: ReturnType<typeof createKeyboardNavigation>,
) {
  const returns = new Map<string, ReturnType<typeof focus.capture>>();
  const recent = new Map<string, string>();
  const pending = new Map<
    string,
    { promise: Promise<void>; intent: AbortController }
  >();
  const workspace = () =>
    getState().workspaces.find((w) => w.id === getState().activeWorkspaceId);
  const isChat = (p: PaneState) =>
    p.kind === "conversation" || (p.kind === "document" && !p.filePath);
  const remember = (event: FocusEvent) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-pane-id]",
    )?.dataset.paneId;
    const w = workspace(),
      pane = w?.panes.find((p) => p.id === id);
    if (w && pane) {
      if (isChat(pane)) recent.set(`${w.id}:chat`, pane.id);
      if (pane.kind === "terminal") recent.set(`${w.id}:terminal`, pane.id);
    }
  };
  document.addEventListener("focusin", remember);
  function targetPane(
    w: WorkspaceState,
    kind: "chat" | "terminal",
  ): PaneState | undefined {
    const candidates = w.panes.filter((p) =>
      kind === "chat" ? isChat(p) : p.kind === "terminal",
    );
    return (
      candidates.find((p) => p.id === w.activePaneId) ??
      candidates.find((p) => p.id === recent.get(`${w.id}:${kind}`)) ??
      candidates.find(
        (p) =>
          p.kind === "conversation" &&
          p.conversationId === w.lastConversationId,
      ) ??
      candidates[0]
    );
  }
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
  function toggle(target: Target, intent = keys.beginFocus()): Promise<void> {
    const key = `${workspace()?.id}:${target}`;
    const existing = pending.get(key);
    if (existing && !existing.intent.signal.aborted) return existing.promise;
    const action = performToggle(target, intent).finally(() => {
      if (pending.get(key)?.promise === action) pending.delete(key);
    });
    pending.set(key, { promise: action, intent });
    return action;
  }
  async function performToggle(
    target: Target,
    intent: AbortController,
  ): Promise<void> {
    // Accepted state can still be awaiting its batched DOM render. Capture both
    // the destination and return control after that frame, never from an old tree.
    const requestedWorkspace = workspace()?.id;
    if (
      !(await keys.whenRendered(
        () => workspace()?.id === requestedWorkspace,
        intent.signal,
      ))
    )
      return;
    const w = workspace();
    if (!w) return;
    const active = document.activeElement as HTMLElement | null;
    const currentId =
      active?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
    const current = w.panes.find((p) => p.id === currentId);
    const within =
      target === "files"
        ? !!active?.closest("#project-panel")
        : target === "workspaces"
          ? !!active?.closest("#workspace-tree")
          : target === "chat"
            ? !!current && isChat(current)
            : current?.kind === "terminal";
    const key = `${w.id}:${target}`;
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
    if (target === "files" || target === "workspaces") {
      const setting = target === "files" ? "filesVisible" : "workspacesVisible";
      const visible =
        target === "files"
          ? w.settings?.filesVisible === true
          : w.settings?.workspacesVisible !== false;
      if (!visible || w.zoomedGroupId) {
        await invoke("workspace.settings", {
          id: w.id,
          settings: { [setting]: true },
        });
        if (
          !(await keys.whenRendered(
            () =>
              workspace()?.id !== w.id
                ? false
                : workspace()?.settings?.[setting] === true || undefined,
            intent.signal,
          ))
        )
          return;
      }
      const host = document.querySelector<HTMLElement>(
        target === "files" ? "#project-panel" : "#workspace-tree",
      );
      (
        host?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ??
        host?.querySelector<HTMLElement>('[role="treeitem"]') ??
        host
      )?.focus();
      return;
    }
    let pane = targetPane(w, target);
    if (!pane && target === "chat") {
      const saved =
        getState().conversations.find(
          (c) => c.workspaceId === w.id && c.id === w.lastConversationId,
        ) ?? getState().conversations.find((c) => c.workspaceId === w.id);
      if (saved) {
        await invoke("conversation.show", { id: saved.id });
        pane = workspace()?.panes.find((p) => p.id === saved.paneId);
      } else {
        const result = await invoke<{ paneId: string }>("conversation.draft", {
          workspace: w.id,
        });
        pane = workspace()?.panes.find((p) => p.id === result.paneId);
      }
    } else if (!pane) {
      const result = await invoke<{ paneId: string }>("terminal.open", {
        workspace: w.id,
        ...(w.folders[0] ? { cwd: w.folders[0] } : {}),
      });
      pane = workspace()?.panes.find((p) => p.id === result.paneId);
    }
    if (pane) {
      recent.set(key, pane.id);
      await keys.focusPane(pane.id, intent);
    }
  }
  return {
    toggle,
    dispose: () => document.removeEventListener("focusin", remember),
  };
}
