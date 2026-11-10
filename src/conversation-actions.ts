import type { AppState, ConversationState } from "./types";

/** Shared removal policy; controller reservations are additionally checked by the host. */
export function conversationRemovalReason(
  state: AppState,
  conversation: ConversationState,
): string | undefined {
  if (conversation.handoffTerminalId)
    return "Return this session to chat before removing it.";
  if (
    ["starting", "working", "waiting"].includes(conversation.status) ||
    conversation.pendingPermissions.length
  )
    return "Stop the current response before removing this chat.";
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
    return "Finish the pending review before removing its originating chat.";
  if (
    state.browsers.some(
      (browser) =>
        browser.agentPage?.conversationId === conversation.id &&
        browser.agentPage.submission?.status !== "completed",
    )
  )
    return "Finish or close the interactive page before removing its originating chat.";
  return undefined;
}
