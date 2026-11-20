import type { AppState, ConversationState } from "./types";

export function acknowledgeConversation(conversation: ConversationState): void {
  conversation.taskStatusAcknowledgedAt =
    conversation.taskStatusUpdatedAt ?? new Date().toISOString();
  conversation.acknowledgedCompletionRevision =
    conversation.completionRevision ?? 0;
}

export function hasRunningBackground(conversation: ConversationState): boolean {
  return (
    conversation.backgroundActivities?.some(
      (item) => item.state === "running",
    ) ?? false
  );
}

export function backgroundWithUnknownState(
  conversation: ConversationState,
): ConversationState["backgroundActivities"] {
  const { backgroundActivities } = conversation;
  if (!hasRunningBackground(conversation)) return backgroundActivities;
  return backgroundActivities?.map((item) =>
    item.state === "running" ? { ...item, state: "unknown" } : item,
  );
}

/** Shared removal policy; controller reservations are additionally checked by the host. */
export function conversationRemovalReason(
  state: AppState,
  conversation: ConversationState,
): string | undefined {
  if (
    state.workspaces.some((workspace) =>
      workspace.panes.some(
        (pane) =>
          pane.kind === "conversation" &&
          pane.conversationId === conversation.id &&
          pane.pinned,
      ),
    )
  )
    return "Unpin this chat before removing it from the workspace.";
  if (conversation.queuedMessages?.length)
    return "Send or cancel queued messages before removing this chat.";
  if (conversation.handoffTerminalId)
    return "Return this session to chat before removing it.";
  if (
    ["starting", "working", "waiting"].includes(conversation.status) ||
    conversation.pendingPermissions.length
  )
    return "Stop the current response before removing this chat.";
  if (hasRunningBackground(conversation))
    return "Wait for background work to finish before removing this chat.";
  const feedback = pendingFeedback(state, conversation);
  if (feedback === "review")
    return "Finish the pending review before removing its originating chat.";
  if (feedback === "page")
    return "Finish or close the interactive page before removing its originating chat.";
  return undefined;
}

/** UI and host share the same feedback and native ownership guard. */
export function conversationHandoffReason(
  state: AppState,
  conversation: ConversationState,
): string | undefined {
  if (conversation.handoffTerminalId)
    return "Conversation is already handed off";
  if (conversation.queuedMessages?.length)
    return "Send or cancel queued messages first";
  if (
    ["starting", "working", "waiting"].includes(conversation.status) ||
    conversation.pendingPermissions.length
  )
    return "Finish or interrupt the active response first";
  if (hasRunningBackground(conversation))
    return "Wait for background work to finish before continuing in CLI.";
  const feedback = pendingFeedback(state, conversation);
  if (feedback === "review")
    return "Finish the pending review before continuing its originating chat in CLI.";
  if (feedback === "page")
    return "Finish or close the interactive page before continuing its originating chat in CLI.";
  return undefined;
}

function pendingFeedback(
  state: AppState,
  conversation: ConversationState,
): "review" | "page" | undefined {
  if (
    state.reviews?.some(
      (review) =>
        review.originConversationId === conversation.id &&
        (review.status === "draft" ||
          review.rounds.some(
            (round) =>
              round.submission &&
              round.submission.delivery.status !== "acknowledged",
          )),
    )
  )
    return "review";
  if (
    state.browsers.some(
      (browser) =>
        browser.agentPage?.conversationId === conversation.id &&
        browser.agentPage.submission?.status !== "completed",
    )
  )
    return "page";
  return undefined;
}
