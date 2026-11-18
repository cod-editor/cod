import { hasRunningBackground } from "../conversation-actions.ts";
import type { AppState, ConversationState } from "../types";
import { conversationLabel } from "./message-label.ts";

export type NavigationKind =
  "workspace" | "conversation" | "browser" | "terminal" | "review";
/** Navigation metadata only: never retain histories, attachments or page content. */
export interface NavigationItem {
  key: string;
  id: string;
  kind: NavigationKind;
  workspaceId: string;
  parent?: string;
  paneId?: string;
  label: string;
  search: string;
  status: string;
  context?: string;
  hint?: string;
  active: boolean;
  pinned: boolean;
}
export function describeNavigationStatus(
  status: string,
  context?: string,
): string {
  const label: Record<string, string> = {
    working: "Working",
    background: "In background",
    waiting: "Needs attention",
    review: "Review requested",
    ready: "Completed",
    failed: "Error",
    starting: "Starting",
    running: "Running",
    exited: "Exited",
  };
  const text = label[status] ?? "Idle";
  return context ? `${text}: ${context}` : text;
}
export function conversationAttention(
  state: AppState,
  conversation: ConversationState,
): string {
  if (conversation.status === "failed" || conversation.error) return "failed";
  if (
    conversation.pendingPermissions.length ||
    conversation.status === "waiting"
  )
    return "waiting";
  if (
    state.reviews?.some(
      (r) =>
        r.originConversationId === conversation.id &&
        r.rounds.some(
          (round) => round.id === r.currentRoundId && round.status === "draft",
        ),
    )
  )
    return "review";
  if (
    conversation.taskStatus === "failed" ||
    conversation.taskStatus === "waiting" ||
    conversation.taskStatus === "review"
  )
    return conversation.taskStatus;
  if (hasRunningBackground(conversation))
    return conversation.status === "working" ? "working" : "background";
  if (
    conversation.taskStatus === "ready" &&
    conversation.taskStatusAcknowledgedAt &&
    (!conversation.taskStatusUpdatedAt ||
      conversation.taskStatusAcknowledgedAt >= conversation.taskStatusUpdatedAt)
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
export function projectNavigation(
  state: AppState,
  presentation: "sidebar" | "overview" = "sidebar",
): NavigationItem[] {
  const result: NavigationItem[] = [];
  for (const workspace of state.workspaces) {
    const root = `workspace:${workspace.id}`;
    const conversations = state.conversations.filter(
      (c) => c.workspaceId === workspace.id,
    );
    const reviews = (state.reviews ?? []).filter(
      (r) =>
        presentation === "sidebar" &&
        r.workspaceId === workspace.id &&
        r.rounds.some(
          (round) =>
            round.id === r.currentRoundId &&
            round.submission?.delivery.status !== "acknowledged",
        ),
    );
    const activePane = workspace.panes.find(
      (p) => p.id === workspace.activePaneId,
    );
    const hasActiveChild =
      conversations.some((c) => c.paneId === workspace.activePaneId) ||
      state.browsers.some(
        (b) =>
          b.workspaceId === workspace.id && b.paneId === workspace.activePaneId,
      ) ||
      (presentation === "overview" &&
        state.terminals.some(
          (terminal) =>
            terminal.workspaceId === workspace.id &&
            terminal.paneId === workspace.activePaneId,
        )) ||
      (activePane?.kind === "review" &&
        reviews.some((r) => r.id === activePane.reviewId));
    const statuses = conversations.map((c) => conversationAttention(state, c));
    const status =
      ["failed", "waiting", "review", "background", "ready", "working"].find(
        (s) => statuses.includes(s),
      ) ?? "";
    const context = status
      ? conversations.find((_, index) => statuses[index] === status)
          ?.taskStatusContext
      : undefined;
    const item = (
      kind: NavigationKind,
      id: string,
      label: string,
      parent?: string,
      paneId?: string,
      attention = "",
      detail?: string,
      extra = "",
    ): NavigationItem => ({
      key: `${kind}:${id}`,
      id,
      kind,
      workspaceId: workspace.id,
      parent,
      paneId,
      label,
      search: `${workspace.name} ${label} ${extra}`.toLowerCase(),
      status: attention,
      context: detail,
      active:
        state.activeWorkspaceId === workspace.id &&
        (kind === "workspace"
          ? !hasActiveChild
          : paneId === workspace.activePaneId),
      pinned: !!workspace.panes.find((p) => p.id === paneId)?.pinned,
    });
    result.push(
      item(
        "workspace",
        workspace.id,
        workspace.name,
        undefined,
        undefined,
        status,
        context,
      ),
    );
    const reviewItem = (review: (typeof reviews)[number], parent: string) =>
      item(
        "review",
        review.id,
        review.target.kind === "document"
          ? review.target.path.split("/").pop() || "Document review"
          : `Changes · ${review.target.repoRoot.split("/").pop()}`,
        parent,
        workspace.panes.find(
          (p) => p.kind === "review" && p.reviewId === review.id,
        )?.id,
        "review",
      );
    conversations.forEach((conversation, index) => {
      const row = item(
        "conversation",
        conversation.id,
        conversationLabel(conversation, state),
        root,
        conversation.paneId,
        statuses[index],
        conversation.taskStatusContext,
      );
      result.push(
        row,
        ...reviews
          .filter((r) => r.originConversationId === conversation.id)
          .map((r) => reviewItem(r, row.key)),
      );
    });
    for (const browser of state.browsers.filter(
      (b) => b.workspaceId === workspace.id,
    )) {
      const row = item(
        "browser",
        browser.id,
        browser.title ||
          (browser.url === "about:blank" ? "New browser tab" : browser.url),
        root,
        browser.paneId,
        "",
        undefined,
        browser.url,
      );
      row.hint = browser.error
        ? `${row.label} - ${browser.error}`
        : browser.url;
      result.push(row);
    }
    if (presentation === "overview")
      for (const terminal of state.terminals.filter(
        (terminal) =>
          terminal.workspaceId === workspace.id &&
          workspace.panes.some(
            (pane) =>
              pane.kind === "terminal" && pane.terminalId === terminal.id,
          ),
      )) {
        const directory =
          terminal.cwd.split(/[\\/]/).filter(Boolean).at(-1) || terminal.cwd;
        const row = item(
          "terminal",
          terminal.id,
          directory ? `Terminal: ${directory}` : "Terminal",
          root,
          terminal.paneId,
          terminal.status,
          terminal.error ??
            (terminal.exitCode === undefined
              ? undefined
              : `Exit code ${terminal.exitCode}`),
          terminal.cwd,
        );
        row.hint = terminal.cwd;
        result.push(row);
      }
    result.push(
      ...reviews
        .filter(
          (r) => !conversations.some((c) => c.id === r.originConversationId),
        )
        .map((r) => reviewItem(r, root)),
    );
  }
  return result;
}

/** Ancestors remain visible during search; browsing never changes application state. */
export function visibleNavigation(
  items: NavigationItem[],
  query: string,
  collapsed: ReadonlySet<string>,
  retainedKey?: string,
): NavigationItem[] {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const byKey = new Map(items.map((item) => [item.key, item]));
  if (tokens.length) {
    const keep = new Set<string>();
    for (const item of items)
      if (
        item.key === retainedKey ||
        tokens.every((token) => item.search.includes(token))
      ) {
        let current: NavigationItem | undefined = item;
        while (current) {
          keep.add(current.key);
          current = current.parent ? byKey.get(current.parent) : undefined;
        }
      }
    return items.filter((item) => keep.has(item.key));
  }
  return items.filter((item) => {
    let parent = item.parent;
    while (parent) {
      if (collapsed.has(parent)) return false;
      parent = byKey.get(parent)?.parent;
    }
    return true;
  });
}
