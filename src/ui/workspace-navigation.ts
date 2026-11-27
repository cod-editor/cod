import { projectNavigation, type NavigationItem } from "./navigation-model";
import type { MenuAction } from "./controls";
import { confirmAction } from "./dialogs";
import type { AppState, ConversationState, WorkspaceState } from "../types";
import type { Invoke } from "./contracts";
type NavigationAction = Exclude<MenuAction, null> & { command?: string };
interface NavigationActions {
  folderDialog: (workspace?: string, restoreFocus?: () => void) => void;
  conversationActions: (
    conversation: ConversationState,
    rename?: () => void,
  ) => Array<NavigationAction | null>;
}
export function createWorkspaceNavigation(
  getState: () => AppState,
  invoke: Invoke,
  actions: NavigationActions,
) {
  const { folderDialog, conversationActions } = actions;
  async function closeWorkspace(workspace: WorkspaceState): Promise<boolean> {
    workspace =
      getState().workspaces.find((w) => w.id === workspace.id) ?? workspace;
    const agents = getState().conversations.filter(
      (c) =>
        c.workspaceId === workspace.id &&
        ["working", "waiting", "starting"].includes(c.status),
    );
    const terminals = [
      ...getState().terminals,
      ...(getState().quickTerminals ?? []),
    ].filter(
      (t) =>
        t.workspaceId === workspace.id &&
        ["running", "starting"].includes(t.status),
    );
    const close = async (force = false) =>
      (
        await invoke<{ closed?: boolean }>("workspace.close", {
          id: workspace.id,
          ...(force ? { force: true } : {}),
        })
      ).closed !== false;
    if (!agents.length && !terminals.length) return close();
    return new Promise((resolve) => {
      let closed = false;
      const confirmation = confirmAction(
        `Close ${workspace.name}?`,
        `${agents.length} active agent${agents.length === 1 ? "" : "s"} and ${terminals.length} running terminal${terminals.length === 1 ? "" : "s"} will stop.`,
        "Stop and close",
        async () => {
          closed = await close(true);
        },
        "Close workspace",
      );
      confirmation.addEventListener("close", () => resolve(closed), {
        once: true,
      });
    });
  }
  async function openItem(
    item: NavigationItem,
    signal?: AbortSignal,
    newShell = false,
  ): Promise<void> {
    if (signal?.aborted) return;
    if (item.closed) {
      await invoke("workspace.reopen", { id: item.id, newShell });
      return;
    }
    const current = projectNavigation(getState(), true).find(
      (row) => row.key === item.key,
    );
    if (!current || signal?.aborted) return;
    await focusWorkspace(current.workspaceId);
    if (signal?.aborted) return;
    if (current.kind === "conversation") {
      await invoke("conversation.show", {
        id: current.id,
        acknowledge: true,
      });
    } else if (current.kind === "review")
      await invoke("review.show", { id: current.id });
    else if (current.kind === "browser" || current.kind === "terminal")
      await invoke("pane.focus", {
        workspace: current.workspaceId,
        id: current.paneId,
      });
  }
  async function closeItem(item: NavigationItem, includePinned = false) {
    if (item.kind === "workspace") {
      const workspace = item.closed
        ? undefined
        : getState().workspaces.find((w) => w.id === item.workspaceId);
      return workspace ? closeWorkspace(workspace) : false;
    }
    if (!item.paneId) return false;
    const result = await invoke<{ closed?: boolean }>("pane.close", {
      workspace: item.workspaceId,
      id: item.paneId,
      includePinned,
    });
    return result.closed !== false;
  }
  function itemActions(
    item: NavigationItem,
    handlers: {
      rename: (item: NavigationItem) => void;
      open: (item: NavigationItem) => void;
      newConversation: (workspace: string) => void;
      openPane: (workspace: string, pane: string) => void;
      restoreFocus: () => void;
    },
  ): Array<NavigationAction | null> {
    const state = getState();
    const current = projectNavigation(state, true).find(
      (row) => row.key === item.key,
    );
    if (!current) return [];
    item = current;
    if (item.closed)
      return [
        {
          label: "Reopen workspace",
          key: "Enter",
          run: () => handlers.open(item),
        },
      ];
    const workspace = state.workspaces.find((w) => w.id === item.workspaceId)!;
    const rename = () => handlers.rename(item);
    const open = () => handlers.open(item);
    if (item.kind === "workspace")
      return [
        { label: "Open workspace", key: "Enter", run: open },
        {
          label: "New chat",
          command: "chat.new",
          run: () => handlers.newConversation(item.workspaceId),
        },
        { label: "Rename workspace", command: "workspace.rename", run: rename },
        {
          label: "Add folder...",
          command: "folders.add",
          run: () => folderDialog(item.workspaceId, handlers.restoreFocus),
        },
        null,
        {
          label: "Close workspace",
          command: "workspace.close",
          run: () => void closeItem(item).catch(() => undefined),
        },
      ];
    const pane = workspace.panes.find((p) => p.id === item.paneId);
    const group = workspace.groups?.find((g) =>
      g.paneIds.includes(item.paneId ?? ""),
    );
    const tabActions: MenuAction[] = pane
      ? [
          null,
          {
            label: pane.pinned ? "Unpin tab" : "Pin tab",
            command: "tab.togglePin",
            run: () =>
              void invoke("pane.pin", {
                workspace: workspace.id,
                id: pane.id,
                pinned: !pane.pinned,
              }),
          },
          {
            label: "Close tab",
            command: pane.pinned ? undefined : "tab.close",
            run: () => void closeItem(item, true).catch(() => undefined),
          },
          {
            label: "Close other tabs",
            command: "tab.closeOthers",
            disabled: !group?.paneIds.some(
              (id) =>
                id !== pane.id &&
                !workspace.panes.find((p) => p.id === id)?.pinned,
            ),
            run: () =>
              void invoke("pane.close-many", {
                workspace: workspace.id,
                group: group?.id,
                scope: "others",
                id: pane.id,
              }),
          },
          {
            label: "Close all tabs",
            command: "tab.closeAll",
            disabled: !group?.paneIds.some(
              (id) => !workspace.panes.find((p) => p.id === id)?.pinned,
            ),
            run: () =>
              void invoke("pane.close-many", {
                workspace: workspace.id,
                group: group?.id,
                scope: "all",
                id: pane.id,
              }),
          },
        ]
      : [];
    if (item.kind === "conversation") {
      const conversation = state.conversations.find((c) => c.id === item.id)!;
      return [
        { label: "Open conversation", key: "Enter", run: open },
        ...conversationActions(conversation, rename).map((action) => {
          if (action?.command !== "conversation.openCli") return action;
          const terminal = state.terminals.find(
            (t) => t.id === conversation.handoffTerminalId,
          );
          return {
            ...action,
            run: () => {
              if (terminal) handlers.openPane(workspace.id, terminal.paneId);
            },
          };
        }),
        ...tabActions,
      ];
    }
    if (item.kind === "browser")
      return [
        { label: "Open tab", key: "Enter", run: open },
        {
          label: "Reload",
          run: () => void invoke("browser.reload", { id: item.id }),
        },
        ...tabActions,
      ];
    if (item.kind === "terminal")
      return [
        { label: "Open terminal", key: "Enter", run: open },
        ...tabActions,
      ];
    const review = state.reviews?.find((review) => review.id === item.id);
    const queued = review?.rounds.filter(
      (round) => round.submission?.delivery.status === "queued",
    );
    const feedbackActions: MenuAction[] =
      review && queued?.length
        ? [
            {
              label: "Cancel queued feedback…",
              run: () => {
                const affected =
                  queued.length === 1
                    ? `round ${queued[0].number}`
                    : `${queued.length} rounds`;
                const confirmation = confirmAction(
                  "Cancel queued feedback?",
                  `Feedback from ${affected} will stay in review history and will no longer be sent.`,
                  "Cancel queued feedback",
                  () =>
                    invoke("review.cancel-queued", {
                      id: review.id,
                      expectedVersion: review.version,
                    }),
                  undefined,
                  "Keep queued",
                );
                confirmation.addEventListener("close", handlers.restoreFocus, {
                  once: true,
                });
              },
            },
          ]
        : [];
    return [
      { label: "Open review", key: "Enter", run: open },
      ...feedbackActions,
      ...tabActions,
    ];
  }
  async function focusWorkspace(id: string): Promise<void> {
    if (id !== getState().activeWorkspaceId)
      await invoke("workspace.focus", { id });
  }

  return {
    items: (includeClosed = false) =>
      projectNavigation(getState(), includeClosed),
    actions: itemActions,
    open: openItem,
    close: closeItem,
    closeWorkspace,
  };
}
