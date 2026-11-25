import { hasRunningBackground } from "../conversation-actions.ts";
import type { AppState, ConversationState } from "../types";
import { conversationLabel } from "../message-label.ts";
import { browserLabel, isBrowserHome } from "./browser-label.ts";

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
  closed?: boolean;
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
    cancelled: "Cancelled",
    ready: "Completed",
    failed: "Error",
    starting: "Starting",
    running: "Running",
    exited: "Exited",
  };
  const text = label[status] ?? "Idle";
  return context ? `${text}: ${context}` : text;
}
function acknowledgedTaskCompletion(conversation: ConversationState): boolean {
  const { taskStatus, taskStatusAcknowledgedAt, taskStatusUpdatedAt } =
    conversation;
  return (
    taskStatus === "ready" &&
    !!taskStatusAcknowledgedAt &&
    (!taskStatusUpdatedAt || taskStatusAcknowledgedAt >= taskStatusUpdatedAt)
  );
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
  if (conversation.status === "working") return "working";
  if (hasRunningBackground(conversation)) return "background";
  const acknowledged = acknowledgedTaskCompletion(conversation);
  if (conversation.taskStatus && !acknowledged) return conversation.taskStatus;
  if (conversation.status === "ready")
    return (conversation.completionRevision ?? 0) >
      (conversation.acknowledgedCompletionRevision ?? 0)
      ? "ready"
      : "";
  return acknowledged ? "" : conversation.status;
}
export function projectNavigation(
  state: AppState,
  includeClosed = false,
): NavigationItem[] {
  const result: NavigationItem[] = [];
  for (const workspace of state.workspaces) {
    const root = `workspace:${workspace.id}`;
    const conversations = state.conversations.filter(
      (c) => c.workspaceId === workspace.id,
    );
    const reviews = (state.reviews ?? []).filter(
      (review) =>
        review.workspaceId === workspace.id &&
        (review.status === "draft" ||
          (includeClosed && review.status === "cancelled") ||
          workspace.panes.some(
            (pane) => pane.kind === "review" && pane.reviewId === review.id,
          ) ||
          review.rounds.some(
            (round) =>
              round.submission &&
              round.submission.delivery.status !== "acknowledged",
          )),
    );
    const hasActiveChild =
      conversations.some((c) => c.paneId === workspace.activePaneId) ||
      state.browsers.some(
        (b) =>
          b.workspaceId === workspace.id && b.paneId === workspace.activePaneId,
      ) ||
      state.terminals.some(
        (terminal) =>
          terminal.workspaceId === workspace.id &&
          terminal.paneId === workspace.activePaneId,
      ) ||
      workspace.panes.some(
        (pane) =>
          pane.id === workspace.activePaneId &&
          pane.kind === "review" &&
          reviews.some((review) => review.id === pane.reviewId),
      );
    const attention = conversations.map((conversation) => {
      const status = conversationAttention(state, conversation);
      const historicalContext =
        conversation.taskStatus === "ready" &&
        (status !== "ready" || acknowledgedTaskCompletion(conversation));
      return {
        status,
        context: historicalContext ? undefined : conversation.taskStatusContext,
      };
    });
    const status =
      ["failed", "waiting", "review", "background", "ready", "working"].find(
        (status) => attention.some((item) => item.status === status),
      ) ?? "";
    const context = attention.find(
      (item) => status && item.status === status,
    )?.context;
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
    const reviewItem = (review: (typeof reviews)[number]) =>
      item(
        "review",
        review.id,
        review.target.kind === "document"
          ? `Review: ${review.target.path.split("/").pop() || "Document"}`
          : `Review: ${review.target.repoRoot.split("/").pop()} changes`,
        root,
        workspace.panes.find(
          (p) => p.kind === "review" && p.reviewId === review.id,
        )?.id,
        review.status === "draft"
          ? "review"
          : review.status === "cancelled"
            ? "cancelled"
            : "",
      );
    conversations.forEach((conversation, index) => {
      const row = item(
        "conversation",
        conversation.id,
        conversationLabel(conversation, state),
        root,
        conversation.paneId,
        attention[index].status,
        attention[index].context,
      );
      result.push(row);
    });
    for (const browser of state.browsers.filter(
      (b) => b.workspaceId === workspace.id,
    )) {
      const address = isBrowserHome(browser) ? "" : browser.url;
      const row = item(
        "browser",
        browser.id,
        browserLabel(browser),
        root,
        browser.paneId,
        "",
        undefined,
        address,
      );
      row.hint = browser.error ? `${row.label} - ${browser.error}` : address;
      result.push(row);
    }
    for (const terminal of state.terminals.filter(
      (terminal) =>
        terminal.workspaceId === workspace.id &&
        workspace.panes.some(
          (pane) => pane.kind === "terminal" && pane.terminalId === terminal.id,
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
    result.push(...reviews.map(reviewItem));
  }
  if (includeClosed) {
    for (const { workspace } of [...(state.closedWorkspaces ?? [])].reverse())
      result.push({
        key: `closed-workspace:${workspace.id}`,
        id: workspace.id,
        kind: "workspace",
        workspaceId: workspace.id,
        label: workspace.name,
        search: workspace.name.toLowerCase(),
        status: "",
        active: false,
        pinned: false,
        closed: true,
      });
  }
  return result;
}

/** Ancestors remain visible during search; browsing never changes application state. */
export function visibleNavigation(
  items: NavigationItem[],
  query: string,
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
  return items;
}
