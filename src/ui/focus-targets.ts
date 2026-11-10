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
  const pending = new Map<string, Promise<void>>();
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
  async function restore(origin: ReturnType<typeof focus.capture>) {
    const browser = origin.browserId
      ? getState().browsers.find((b) => b.id === origin.browserId)
      : undefined;
    const id = browser?.paneId ?? origin.paneId ?? origin.tabId;
    const owner = id
      ? getState().workspaces.find((w) => w.panes.some((p) => p.id === id))
      : undefined;
    if (owner && id) await invoke("pane.focus", { workspace: owner.id, id });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    focus.restore(origin);
  }
  function toggle(target: Target): Promise<void> {
    const key = `${workspace()?.id}:${target}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const action = performToggle(target).finally(() => pending.delete(key));
    pending.set(key, action);
    return action;
  }
  async function performToggle(target: Target): Promise<void> {
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
      await restore(origin);
      return;
    }
    if (!within) returns.set(key, focus.capture());
    if (target === "files" || target === "workspaces") {
      const setting = target === "files" ? "filesVisible" : "workspacesVisible";
      await invoke("workspace.settings", {
        id: w.id,
        settings: { [setting]: true },
      });
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
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
      await keys.focusPane(pane.id);
    }
  }
  function chatVisibilityReason() {
    const w = workspace();
    if (!w) return "Open a workspace first";
    const pane = targetPane(w, "chat"),
      group = w.groups?.find((g) => g.paneIds.includes(pane?.id ?? ""));
    if (
      group &&
      !group.hidden &&
      (!w.zoomedGroupId || w.zoomedGroupId === group.id) &&
      (w.groups?.filter((g) => !g.hidden).length ?? 0) <= 1
    )
      return "At least one pane must remain open";
  }
  async function toggleChatArea(): Promise<void> {
    const w = workspace();
    if (!w) return;
    const pane = targetPane(w, "chat");
    if (!pane) {
      await invoke("conversation.draft", { workspace: w.id });
      return;
    }
    const group = w.groups?.find((g) => g.paneIds.includes(pane.id));
    if (!group) return;
    const visible =
      !group.hidden && (!w.zoomedGroupId || w.zoomedGroupId === group.id);
    if (visible) {
      if (chatVisibilityReason()) return;
      const inside =
        document.activeElement?.closest<HTMLElement>("[data-group-id]")?.dataset
          .groupId === group.id;
      await invoke("group.visibility", {
        workspace: w.id,
        id: group.id,
        hidden: true,
      });
      if (inside) {
        const active = workspace();
        if (active) await keys.focusPane(active.activePaneId);
      }
    } else {
      await invoke("group.visibility", {
        workspace: w.id,
        id: group.id,
        hidden: false,
      });
      if (w.zoomedGroupId)
        await invoke("group.zoom", { workspace: w.id, id: w.zoomedGroupId });
    }
  }
  return {
    toggle,
    toggleChatArea,
    chatVisibilityReason,
    dispose: () => document.removeEventListener("focusin", remember),
  };
}
