import { treeRowParts } from "./tree-row";
import { reconcileView } from "./view-reconcile";
import { conversationLabel } from "./message-label";
import { icon, menu, type MenuAction } from "./controls";
import { readPreference, writePreference } from "./preferences";
import type { AppState, ConversationState, WorkspaceState } from "../types";
import type { Invoke } from "./contracts";
interface NavigationActions {
  newConversation: () => Promise<unknown>;
  folderDialog: (workspace?: string) => void;
  conversationActions: (conversation: ConversationState) => MenuAction[];
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
  function describeStatus(status: string, context?: string): string {
    const text =
      (
        {
          working: "Working",
          waiting: "Needs attention",
          review: "Review requested",
          ready: "Completed",
          failed: "Error",
          starting: "Starting",
        } as Record<string, string>
      )[status] ?? "Idle";
    return context ? `${text}: ${context}` : text;
  }
  function applyStatus(
    row: HTMLElement,
    label: string,
    status: string,
    context?: string,
  ) {
    row.dataset.status = status;
    const description = describeStatus(status, context);
    row.title = `${label} - ${description}`;
    row.setAttribute("aria-label", `${label}, ${description}`);
  }
  function attentionStatus(
    conversation: import("../types").ConversationState,
  ): string {
    if (conversation.status === "failed" || conversation.error) return "failed";
    if (
      conversation.pendingPermissions.length ||
      conversation.status === "waiting"
    )
      return "waiting";
    if (
      getState().reviews?.some(
        (r) =>
          r.originConversationId === conversation.id &&
          r.rounds.some(
            (round) =>
              round.id === r.currentRoundId && round.status === "draft",
          ),
      )
    )
      return "review";
    if (
      conversation.taskStatus === "ready" &&
      conversation.taskStatusAcknowledgedAt &&
      (!conversation.taskStatusUpdatedAt ||
        conversation.taskStatusAcknowledgedAt >=
          conversation.taskStatusUpdatedAt)
    )
      return "";
    if (conversation.taskStatus) return conversation.taskStatus;
    if (conversation.status === "ready")
      return (conversation.completionRevision ?? 0) >
        (conversation.acknowledgedCompletionRevision ?? 0)
        ? "ready"
        : "";
    return conversation.status;
  }
  function closeWorkspace(workspace: WorkspaceState): void {
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
    if (!agents.length && !terminals.length) {
      void invoke("workspace.close", { id: workspace.id });
      return;
    }
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "Close workspace");
    const title = document.createElement("h2");
    title.textContent = `Close ${workspace.name}?`;
    const text = document.createElement("p");
    text.textContent = `${agents.length} active agent${agents.length === 1 ? "" : "s"} and ${terminals.length} running terminal${terminals.length === 1 ? "" : "s"} will stop.`;
    const cancel = paneButton("Cancel", async () => dialog.close());
    const close = paneButton("Stop and close", async () => {
      await invoke("workspace.close", { id: workspace.id, force: true });
      dialog.close();
    });
    dialog.append(title, text, cancel, close);
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
    | { id: string; value: string; origin: HTMLElement | null; saving: boolean }
    | undefined;
  async function renameWorkspace(id: string): Promise<void> {
    const workspace = getState().workspaces.find((item) => item.id === id);
    if (!workspace) return;
    const origin = document.activeElement as HTMLElement | null;
    const active = getState().workspaces.find(
      (item) => item.id === getState().activeWorkspaceId,
    );
    if (
      active &&
      (active.settings?.workspacesVisible === false || active.zoomedGroupId)
    )
      await invoke("workspace.settings", {
        id: active.id,
        settings: { workspacesVisible: true },
      });
    editing = { id, value: workspace.name, origin, saving: false };
    renderTree();
    requestAnimationFrame(() => {
      const input = tree.querySelector<HTMLInputElement>(
        ".workspace-name-input",
      );
      input?.focus();
      input?.select();
    });
  }
  function endRename(restore: boolean): void {
    const origin = editing?.origin;
    const id = editing?.id;
    editing = undefined;
    renderTree();
    if (restore) {
      if (origin?.isConnected) origin.focus();
      else
        tree.querySelector<HTMLElement>(`[data-workspace-id="${id}"]`)?.focus();
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
      await invoke("workspace.rename", { id: edit.id, name });
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
  let renderedSignature = "";
  function renderTree(): void {
    const host = tree;
    const nextTree = host.cloneNode(false) as HTMLElement;
    const next = getState();
    const signature = JSON.stringify([
      next.activeWorkspaceId,
      editing?.id,
      next.workspaces.map((w) => [w.id, w.name, w.activePaneId, w.panes]),
      next.conversations.map((c) => [
        c.id,
        c.workspaceId,
        c.paneId,
        conversationLabel(c, next),
        attentionStatus(c),
        c.taskStatusContext,
        c.handoffTerminalId,
      ]),
      next.terminals.map((t) => [t.id, t.status]),
      next.reviews?.map((r) => [
        r.id,
        r.workspaceId,
        r.target,
        r.originConversationId,
        r.currentRoundId,
        r.rounds.map((round) => [
          round.id,
          round.status,
          round.submission?.delivery.status,
        ]),
      ]),
      [...collapsedWorkspaces],
    ]);
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    writePreference("collapsed-workspaces", [...collapsedWorkspaces]);
    nextTree.replaceChildren();
    for (const workspace of getState().workspaces) {
      const row = treeRow(
        workspace.id,
        workspace.name,
        workspace.id === getState().activeWorkspaceId &&
          (collapsedWorkspaces.has(workspace.id) ||
            !getState().conversations.some(
              (c) =>
                c.workspaceId === workspace.id &&
                c.paneId === workspace.activePaneId,
            )),
      );
      row.setAttribute("aria-label", workspace.name);
      row.classList.add("workspace-parent");
      row.setAttribute(
        "aria-expanded",
        String(!collapsedWorkspaces.has(workspace.id)),
      );
      row.replaceChildren();
      const parts = treeRowParts(
        "workspace",
        workspace.name,
        () => {
          if (collapsedWorkspaces.has(workspace.id))
            collapsedWorkspaces.delete(workspace.id);
          else collapsedWorkspaces.add(workspace.id);
          renderTree();
        },
        "Expand or collapse workspace",
      );
      row.append(...parts.nodes);
      parts.label.ondblclick = (event) => {
        event.stopPropagation();
        void renameWorkspace(workspace.id);
      };
      if (editing?.id === workspace.id) {
        const input = document.createElement("input");
        input.className = "workspace-name-input";
        input.setAttribute("aria-label", "Workspace name");
        input.dataset.focusKey = `rename-workspace:${workspace.id}`;
        input.value = editing.value;
        input.onclick = (event) => event.stopPropagation();
        input.ondblclick = (event) => event.stopPropagation();
        input.oninput = () => {
          if (editing?.id === workspace.id) editing.value = input.value;
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
          if (editing?.id === workspace.id) void saveRename(false);
        };
        parts.label.replaceWith(input);
      }
      if (collapsedWorkspaces.has(workspace.id)) {
        const count = getState().conversations.filter(
          (c) => c.workspaceId === workspace.id,
        ).length;
        if (count) {
          const hiddenCount = document.createElement("span");
          hiddenCount.className = "workspace-child-count";
          hiddenCount.textContent = String(count);
          hiddenCount.setAttribute(
            "aria-label",
            `${count} hidden conversation${count === 1 ? "" : "s"}`,
          );
          hiddenCount.title = hiddenCount.getAttribute("aria-label")!;
          row.append(hiddenCount);
        }
      }
      const statuses = getState()
        .conversations.filter((c) => c.workspaceId === workspace.id)
        .map(attentionStatus);
      const attention = [
        "failed",
        "waiting",
        "review",
        "ready",
        "working",
      ].find((s) => statuses.includes(s));
      const source = getState().conversations.find(
        (c) =>
          c.workspaceId === workspace.id && attentionStatus(c) === attention,
      );
      applyStatus(
        row,
        workspace.name,
        attention ?? "",
        source?.taskStatusContext,
      );
      row.onclick = () => void focusWorkspace(workspace.id);
      row.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void focusWorkspace(workspace.id);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          if (e.key === "ArrowLeft") collapsedWorkspaces.add(workspace.id);
          else if (!collapsedWorkspaces.has(workspace.id)) {
            row.nextElementSibling instanceof HTMLElement &&
              row.nextElementSibling.dataset.parentId === workspace.id &&
              row.nextElementSibling.focus();
            return;
          } else collapsedWorkspaces.delete(workspace.id);
          renderTree();
        } else navigateTree(e, row);
      };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        menu({ x: e.clientX, y: e.clientY }, [
          {
            label: "New chat",
            run: () =>
              void focusWorkspace(workspace.id).then(() => newConversation()),
          },
          {
            label: "Rename workspace",
            run: () => void renameWorkspace(workspace.id),
          },
          {
            label: "Add folder...",
            run: () =>
              void focusWorkspace(workspace.id).then(() =>
                folderDialog(workspace.id),
              ),
          },
          null,
          {
            label: "Close workspace",
            run: () => closeWorkspace(workspace),
          },
        ]);
      };
      nextTree.append(row);
      if (collapsedWorkspaces.has(workspace.id)) continue;
      for (const conversation of getState().conversations.filter(
        (c) => c.workspaceId === workspace.id,
      )) {
        const label = conversationLabel(conversation, getState()).slice(0, 80);
        const item = treeRow(
          conversation.id,
          label,
          workspace.id === getState().activeWorkspaceId &&
            workspace.activePaneId === conversation.paneId,
        );
        item.classList.add("conversation-row");
        item.dataset.parentId = workspace.id;
        const attention = attentionStatus(conversation);
        applyStatus(item, label, attention, conversation.taskStatusContext);
        item.replaceChildren(icon("conversation"));
        const text = document.createElement("span");
        text.className = "tree-label";
        text.textContent = label;
        item.append(text);
        item.oncontextmenu = (event) => {
          event.preventDefault();
          menu(
            { x: event.clientX, y: event.clientY },
            conversationActions(
              getState().conversations.find((c) => c.id === conversation.id) ??
                conversation,
            ),
          );
        };
        item.onclick = () => void activateConversation(conversation.id);
        item.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void activateConversation(conversation.id);
          } else navigateTree(e, item);
        };
        nextTree.append(item);
      }
      for (const review of getState().reviews?.filter(
        (r) => r.workspaceId === workspace.id,
      ) ?? []) {
        const current = review.rounds.find(
          (r) => r.id === review.currentRoundId,
        );
        if (!current || current.submission?.delivery.status === "acknowledged")
          continue;
        const reviewLabel =
          review.target.kind === "document"
            ? review.target.path.split("/").pop() || "Document review"
            : `Changes · ${review.target.repoRoot.split("/").pop()}`;
        const item = treeRow(review.id, reviewLabel, false);
        item.setAttribute("aria-label", reviewLabel);
        applyStatus(item, reviewLabel, "review");
        item.classList.add("review-row");
        item.dataset.parentId = review.originConversationId ?? workspace.id;
        item.replaceChildren(
          icon("review"),
          document.createTextNode(reviewLabel),
        );
        const open = async () => {
          await focusWorkspace(workspace.id);
          await invoke("review.show", { id: review.id });
        };
        item.onclick = () => void open();
        item.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void open();
          } else navigateTree(e, item);
        };
        const origin = nextTree.querySelector<HTMLElement>(
          `[data-workspace-id="${review.originConversationId}"]`,
        );
        if (origin) {
          let after: Element = origin;
          while (after.nextElementSibling?.classList.contains("review-row"))
            after = after.nextElementSibling;
          after.after(item);
        } else nextTree.append(item);
      }
    }
    reconcileView(host, nextTree);
    const focused =
      document.activeElement?.closest<HTMLElement>('[role="treeitem"]');
    const current =
      focused && host.contains(focused)
        ? focused
        : (host.querySelector<HTMLElement>('[aria-selected="true"]') ??
          host.querySelector<HTMLElement>('[role="treeitem"]'));
    for (const row of host.querySelectorAll<HTMLElement>('[role="treeitem"]'))
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
    activate: activateConversation,
    focusWorkspace,
    renameWorkspace,
  };
}
