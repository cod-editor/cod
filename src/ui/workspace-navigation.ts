import { treeRowParts } from "./tree-row";
import { reconcileView } from "./view-reconcile";
import { conversationLabel } from "./message-label";
import {
  projectNavigation,
  describeNavigationStatus,
  type NavigationItem,
} from "./navigation-model";
import { icon, menu, type MenuAction } from "./controls";
import { readPreference, writePreference } from "./preferences";
import type { AppState, ConversationState, WorkspaceState } from "../types";
import type { Invoke } from "./contracts";
type NavigationAction = Exclude<MenuAction, null> & { command?: string };
interface NavigationActions {
  newConversation: (workspace?: string) => Promise<unknown>;
  folderDialog: (workspace?: string, restoreFocus?: () => void) => void;
  conversationActions: (
    conversation: ConversationState,
    rename?: () => void,
  ) => Array<NavigationAction | null>;
  paneButton: (
    label: string,
    action: () => Promise<unknown>,
  ) => HTMLButtonElement;
}
export function createWorkspaceNavigation(
  tree: HTMLElement,
  getState: () => AppState,
  invoke: Invoke,
  actions: NavigationActions,
) {
  const { newConversation, folderDialog, conversationActions, paneButton } =
    actions;
  function applyStatus(
    row: HTMLElement,
    label: string,
    status: string,
    context?: string,
  ) {
    row.dataset.status = status;
    row.title = `${label} - ${describeNavigationStatus(status, context)}`;
    row.setAttribute(
      "aria-label",
      `${label}, ${describeNavigationStatus(status, context)}`,
    );
  }
  function closeWorkspace(workspace: WorkspaceState, restoreTree = true): void {
    workspace =
      getState().workspaces.find((w) => w.id === workspace.id) ?? workspace;
    const agents = getState().conversations.filter(
      (c) =>
        c.workspaceId === workspace.id &&
        ["working", "waiting", "starting"].includes(c.status),
    );
    const terminals = getState().terminals.filter(
      (t) =>
        t.workspaceId === workspace.id &&
        ["running", "starting"].includes(t.status),
    );
    const order = getState().workspaces.map((item) => item.id);
    const index = order.indexOf(workspace.id);
    const initialFocus = document.activeElement;
    const close = async (force = false) => {
      await invoke("workspace.close", {
        id: workspace.id,
        ...(force ? { force: true } : {}),
      });
      if (!restoreTree) return;
      requestAnimationFrame(() => {
        const focused = document.activeElement;
        if (
          focused &&
          focused !== document.body &&
          focused !== initialFocus &&
          !tree.contains(focused) &&
          !focused.closest("dialog")
        )
          return;
        renderTree();
        const remaining = getState().workspaces.map((item) => item.id);
        const target = remaining.includes(workspace.id)
          ? workspace.id
          : ([
              ...order.slice(index + 1),
              ...order.slice(0, index).reverse(),
            ].find((id) => remaining.includes(id)) ?? remaining[0]);
        const row = target
          ? tree.querySelector<HTMLElement>(`[data-workspace-id="${target}"]`)
          : null;
        if (row) row.focus();
        else
          document
            .querySelector<HTMLButtonElement>('button[aria-label="Overview"]')
            ?.focus();
      });
    };
    if (!agents.length && !terminals.length) {
      void close();
      return;
    }
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "Close workspace");
    const title = document.createElement("h2");
    title.textContent = `Close ${workspace.name}?`;
    const text = document.createElement("p");
    text.textContent = `${agents.length} active agent${agents.length === 1 ? "" : "s"} and ${terminals.length} running terminal${terminals.length === 1 ? "" : "s"} will stop.`;
    const cancel = paneButton("Cancel", async () => dialog.close());
    const confirm = paneButton("Stop and close", async () => {
      await close(true);
      dialog.close();
    });
    dialog.append(title, text, cancel, confirm);
    document.body.append(dialog);
    dialog.onclose = () => dialog.remove();
    dialog.showModal();
    cancel.focus();
  }
  tree.addEventListener("focusin", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      '[role="treeitem"]',
    );
    if (row)
      for (const item of tree.querySelectorAll<HTMLElement>(
        '[role="treeitem"]',
      ))
        item.tabIndex = item === row ? 0 : -1;
  });
  const collapsedWorkspaces = new Set<string>(
    readPreference<string[]>("collapsed-workspaces", []),
  );
  let editing:
    | {
        id: string;
        kind: "workspace" | "conversation";
        value: string;
        origin: HTMLElement | null;
        saving: boolean;
      }
    | undefined;
  async function revealWorkspaceTree(): Promise<void> {
    const active = getState().workspaces.find(
      (item) => item.id === getState().activeWorkspaceId,
    );
    if (
      active &&
      (active.settings?.workspacesVisible === false || active.zoomedGroupId)
    ) {
      await invoke("workspace.settings", {
        id: active.id,
        settings: { workspacesVisible: true },
      });
      // Apply the revealed panel layout before creating and focusing its editor.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
  }
  async function renameWorkspace(id: string): Promise<void> {
    const workspace = getState().workspaces.find((item) => item.id === id);
    if (!workspace) return;
    const origin = document.activeElement as HTMLElement | null;
    await revealWorkspaceTree();
    editing = {
      id,
      kind: "workspace",
      value: workspace.name,
      origin,
      saving: false,
    };
    renderTree();
    const input = tree.querySelector<HTMLInputElement>(".workspace-name-input");
    input?.focus();
    input?.select();
  }
  async function renameConversation(id: string): Promise<void> {
    const conversation = getState().conversations.find((c) => c.id === id);
    if (!conversation) return;
    const origin = document.activeElement as HTMLElement | null;
    await revealWorkspaceTree();
    collapsedWorkspaces.delete(conversation.workspaceId);
    editing = {
      id,
      kind: "conversation",
      value: conversationLabel(conversation, getState()),
      origin,
      saving: false,
    };
    renderTree();
    const input = tree.querySelector<HTMLInputElement>(".workspace-name-input");
    input?.focus();
    input?.select();
  }
  function renameInput(
    id: string,
    kind: "workspace" | "conversation",
  ): HTMLInputElement {
    const input = document.createElement("input");
    input.className = "workspace-name-input";
    input.setAttribute(
      "aria-label",
      kind === "workspace" ? "Workspace name" : "Conversation name",
    );
    input.dataset.focusKey = `rename-${kind}:${id}`;
    input.maxLength = 255;
    input.value = editing?.value ?? "";
    input.onclick = input.ondblclick = (event) => event.stopPropagation();
    input.oninput = () => {
      if (editing?.id === id) editing.value = input.value;
    };
    input.onkeydown = (event) => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        void saveRename(true);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        endRename(true);
      }
    };
    input.onblur = () => {
      if (editing?.id === id) void saveRename(false);
    };
    return input;
  }
  function endRename(restore: boolean): void {
    const origin = editing?.origin;
    const id = editing?.id;
    editing = undefined;
    renderTree();
    if (restore) {
      const row = tree.querySelector<HTMLElement>(
        `[data-workspace-id="${id}"]`,
      );
      if (row) row.focus();
      else if (origin?.isConnected && origin !== document.body) origin.focus();
    }
  }
  async function saveRename(restore: boolean): Promise<void> {
    const edit = editing;
    if (!edit || edit.saving) return;
    const name = edit.value.trim();
    if (!name) {
      endRename(restore);
      return;
    }
    edit.saving = true;
    try {
      await invoke(
        edit.kind === "workspace" ? "workspace.rename" : "conversation.rename",
        { id: edit.id, name },
      );
      if (editing === edit) endRename(restore);
    } catch {
      if (editing === edit) {
        edit.saving = false;
        const input = tree.querySelector<HTMLInputElement>(
          ".workspace-name-input",
        );
        input?.setAttribute("aria-invalid", "true");
        input?.focus();
      }
    }
  }
  async function openItem(
    item: NavigationItem,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = projectNavigation(getState()).find(
      (row) => row.key === item.key,
    );
    if (!current || signal?.aborted) return;
    await focusWorkspace(current.workspaceId);
    if (signal?.aborted) return;
    if (current.kind === "conversation") {
      await invoke("conversation.show", { id: current.id });
      if (!signal?.aborted)
        await invoke("conversation.acknowledge", { id: current.id });
    } else if (current.kind === "review")
      await invoke("review.show", { id: current.id });
    else if (current.kind === "browser")
      await invoke("pane.focus", {
        workspace: current.workspaceId,
        id: current.paneId,
      });
  }
  async function closeItem(
    item: NavigationItem,
    includePinned = false,
    restoreTree = true,
  ): Promise<void> {
    const rows = [
      ...tree.querySelectorAll<HTMLElement>("[data-navigation-key]"),
    ];
    const index = rows.findIndex(
      (row) => row.dataset.navigationKey === item.key,
    );
    const order = [
      ...rows.slice(index + 1),
      ...rows.slice(0, index).reverse(),
    ].map((row) => row.dataset.navigationKey);
    const result = await invoke<{ closed?: boolean }>("pane.close", {
      workspace: item.workspaceId,
      id: item.paneId,
      includePinned,
    });
    if (result.closed === false || !restoreTree) return;
    requestAnimationFrame(() => {
      const surviving = [
        ...tree.querySelectorAll<HTMLElement>("[data-navigation-key]"),
      ];
      const next =
        order
          .map((key) =>
            surviving.find((row) => row.dataset.navigationKey === key),
          )
          .find(Boolean) ?? surviving[0];
      if (!document.querySelector("dialog[open]")) next?.focus();
    });
  }
  function itemActions(
    item: NavigationItem,
    overrides: {
      rename?: (item: NavigationItem) => void;
      open?: (item: NavigationItem) => void;
      newConversation?: (workspace: string) => void;
      openPane?: (workspace: string, pane: string) => void;
      restoreTree?: boolean;
      restoreFocus?: () => void;
    } = {},
  ): Array<NavigationAction | null> {
    const state = getState();
    const current = projectNavigation(state).find(
      (row) => row.key === item.key,
    );
    if (!current) return [];
    item = current;
    const workspace = state.workspaces.find((w) => w.id === item.workspaceId)!;
    const rename = () =>
      overrides.rename
        ? overrides.rename(item)
        : void (item.kind === "workspace"
            ? renameWorkspace(item.id)
            : renameConversation(item.id));
    const open = () =>
      overrides.open ? overrides.open(item) : void openItem(item);
    if (item.kind === "workspace")
      return [
        { label: "Open workspace", run: open },
        {
          label: "New chat",
          run: () =>
            overrides.newConversation
              ? overrides.newConversation(item.workspaceId)
              : void focusWorkspace(item.workspaceId).then(() =>
                  newConversation(),
                ),
        },
        { label: "Rename workspace", run: rename },
        { label: "Add folder...", run: () => folderDialog(item.workspaceId) },
        null,
        {
          label: "Close workspace",
          run: () => closeWorkspace(workspace, overrides.restoreTree !== false),
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
            run: () =>
              void invoke("pane.pin", {
                workspace: workspace.id,
                id: pane.id,
                pinned: !pane.pinned,
              }),
          },
          {
            label: "Close tab",
            run: () =>
              void closeItem(item, true, overrides.restoreTree !== false),
          },
          {
            label: "Close other tabs",
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
        { label: "Open conversation", run: open },
        ...conversationActions(conversation, rename).map((action) => {
          if (action?.command !== "conversation.openCli" || !overrides.openPane)
            return action;
          const terminal = state.terminals.find(
            (t) => t.id === conversation.handoffTerminalId,
          );
          return {
            ...action,
            run: () => {
              if (terminal) overrides.openPane!(workspace.id, terminal.paneId);
            },
          };
        }),
        ...tabActions,
      ];
    }
    if (item.kind === "browser")
      return [
        { label: "Open tab", run: open },
        {
          label: "Reload",
          run: () => void invoke("browser.reload", { id: item.id }),
        },
        ...tabActions,
      ];
    return [{ label: "Open review", run: open }, ...tabActions];
  }
  let renderedSignature = "";
  function renderTree(): void {
    const items = projectNavigation(getState());
    const signature = JSON.stringify([
      items,
      editing?.id,
      [...collapsedWorkspaces],
    ]);
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    writePreference("collapsed-workspaces", [...collapsedWorkspaces]);
    const nextTree = tree.cloneNode(false) as HTMLElement;
    for (const item of items) {
      if (
        item.kind !== "workspace" &&
        collapsedWorkspaces.has(item.workspaceId)
      )
        continue;
      const active =
        item.active ||
        (item.kind === "workspace" &&
          item.workspaceId === getState().activeWorkspaceId &&
          collapsedWorkspaces.has(item.id));
      const displayLabel =
        item.kind === "conversation"
          ? item.label.slice(0, 80)
          : item.kind === "browser"
            ? item.label.slice(0, 160)
            : item.label;
      const row = treeRow(item.id, displayLabel, active);
      row.dataset.navigationKey = item.key;
      if (item.kind === "browser") {
        row.title = item.hint ?? item.label;
        row.setAttribute("aria-label", displayLabel);
      } else applyStatus(row, displayLabel, item.status, item.context);

      if (item.pinned)
        row.setAttribute(
          "aria-label",
          `${row.getAttribute("aria-label")}, Pinned`,
        );
      if (item.parent)
        row.dataset.parentId = item.parent.slice(item.parent.indexOf(":") + 1);
      if (item.kind === "workspace") {
        row.classList.add("workspace-parent");
        row.setAttribute(
          "aria-expanded",
          String(!collapsedWorkspaces.has(item.id)),
        );
        const parts = treeRowParts(
          "workspace",
          item.label,
          () => {
            if (collapsedWorkspaces.has(item.id))
              collapsedWorkspaces.delete(item.id);
            else collapsedWorkspaces.add(item.id);
            renderedSignature = "";
            renderTree();
          },
          "Expand or collapse workspace",
        );
        row.replaceChildren(...parts.nodes);
        if (collapsedWorkspaces.has(item.id)) {
          const count = items.filter(
            (child) =>
              child.workspaceId === item.id &&
              ["conversation", "browser"].includes(child.kind),
          ).length;
          if (count) {
            const badge = document.createElement("span");
            badge.className = "workspace-child-count";
            badge.textContent = String(count);
            const conversations = items.filter(
              (child) =>
                child.workspaceId === item.id && child.kind === "conversation",
            ).length;
            const browsers = count - conversations;
            badge.setAttribute(
              "aria-label",
              [
                conversations && `${conversations} hidden conversations`,
                browsers && `${browsers} hidden browser tabs`,
              ]
                .filter(Boolean)
                .join(", "),
            );
            row.append(badge);
          }
        }
      } else {
        row.classList.add(`${item.kind}-row`);
        if (item.kind === "browser") row.dataset.browserId = item.id;
        const label = document.createElement("span");
        label.className = "tree-label";
        label.textContent = displayLabel;
        row.replaceChildren(icon(item.kind), label);
      }
      const label = row.querySelector<HTMLElement>(".tree-label")!;
      if (item.kind === "workspace" || item.kind === "conversation") {
        label.ondblclick = (event) => {
          event.stopPropagation();
          void (item.kind === "workspace"
            ? renameWorkspace(item.id)
            : renameConversation(item.id));
        };
        if (editing?.id === item.id)
          label.replaceWith(renameInput(item.id, item.kind));
      }
      if (item.pinned) {
        const pin = icon("pin");
        pin.classList.add("navigation-pin");
        row.append(pin);
      }
      row.onclick = () => void openItem(item);
      row.oncontextmenu = (event) => {
        event.preventDefault();
        menu({ x: event.clientX, y: event.clientY }, itemActions(item));
      };
      row.onkeydown = (event) => {
        if (event.isComposing) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (event.repeat) return;
          if (
            event.key === "Enter" &&
            (item.kind === "workspace" || item.kind === "conversation")
          )
            void (item.kind === "workspace"
              ? renameWorkspace(item.id)
              : renameConversation(item.id));
          else void openItem(item);
        } else if (
          item.kind === "workspace" &&
          ["ArrowLeft", "ArrowRight"].includes(event.key)
        ) {
          event.preventDefault();
          if (event.key === "ArrowLeft") collapsedWorkspaces.add(item.id);
          else if (!collapsedWorkspaces.has(item.id)) {
            (row.nextElementSibling as HTMLElement | null)?.focus();
            return;
          } else collapsedWorkspaces.delete(item.id);
          renderedSignature = "";
          renderTree();
        } else if (
          item.kind === "browser" &&
          ["Delete", "Backspace"].includes(event.key)
        ) {
          event.preventDefault();
          if (!event.repeat) void closeItem(item);
        } else navigateTree(event, row);
      };
      nextTree.append(row);
    }
    reconcileView(tree, nextTree);
    const focused =
      document.activeElement?.closest<HTMLElement>('[role="treeitem"]');
    const current =
      focused && tree.contains(focused)
        ? focused
        : (tree.querySelector<HTMLElement>('[aria-selected="true"]') ??
          tree.querySelector<HTMLElement>('[role="treeitem"]'));
    for (const row of tree.querySelectorAll<HTMLElement>('[role="treeitem"]'))
      row.tabIndex = row === current ? 0 : -1;
  }

  function treeRow(key: string, label: string, selected: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "workspace-row";
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-selected", String(selected));
    row.dataset.workspaceId = key;
    row.tabIndex = selected ? 0 : -1;
    row.textContent = label;
    return row;
  }

  function navigateTree(event: KeyboardEvent, row: HTMLElement): void {
    if (event.isComposing) return;
    if (event.key === "ArrowLeft" && row.dataset.parentId) {
      event.preventDefault();
      tree
        .querySelector<HTMLElement>(
          `[data-workspace-id="${row.dataset.parentId}"]`,
        )
        ?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const rows = [...tree.querySelectorAll<HTMLElement>("[role=treeitem]")];
    const index = rows.indexOf(row);
    rows[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : Math.max(
              0,
              Math.min(
                rows.length - 1,
                index + (event.key === "ArrowDown" ? 1 : -1),
              ),
            )
    ]?.focus();
  }

  async function activateConversation(id: string): Promise<void> {
    const conversation = getState().conversations.find(
      (item) => item.id === id,
    );
    if (!conversation) return;
    if (collapsedWorkspaces.delete(conversation.workspaceId)) renderTree();
    if (conversation.workspaceId !== getState().activeWorkspaceId) {
      await invoke("workspace.focus", { id: conversation.workspaceId });
    }
    await invoke("conversation.show", { id: conversation.id });
    await invoke("conversation.acknowledge", { id: conversation.id });
  }

  async function focusWorkspace(id: string): Promise<void> {
    if (id !== getState().activeWorkspaceId)
      await invoke("workspace.focus", { id });
  }

  return {
    render: renderTree,
    items: () => projectNavigation(getState()),
    actions: itemActions,
    open: openItem,
    activate: activateConversation,
    focusWorkspace,
    renameWorkspace,
    renameConversation,
    closeWorkspace,
  };
}
