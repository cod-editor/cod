import type { AppState, ConversationState } from "../types";
export function structuredMessageLabel(
  text: string,
  state: AppState,
): string | undefined {
  if (!text.trimStart().startsWith("{")) return;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value.submissionId !== "string") return;
    if (typeof value.pageId === "string" && "response" in value) {
      const page = state.browsers.find(
        (b) => b.id === value.pageId && b.agentPage,
      );
      if (page)
        return `Response to ${page.title || page.agentPage!.path.split("/").pop() || "agent page"}`;
    }
    if (typeof value.reviewId === "string" && Array.isArray(value.comments)) {
      const review = state.reviews?.find((r) => r.id === value.reviewId);
      if (review) {
        const name =
          review.target.kind === "document"
            ? review.target.path.split("/").pop()
            : review.target.repoRoot.split("/").pop();
        return value.comments.length
          ? `Review feedback: ${name} (${value.comments.length} comments)`
          : `Approved: ${name}`;
      }
    }
  } catch {
    /* Ordinary conversation text is rendered without interpretation. */
  }
}
export function conversationLabel(
  conversation: ConversationState,
  state: AppState,
): string {
  const first = conversation.messages.find(
    (message) => message.role === "user",
  );
  return (
    (first &&
      (structuredMessageLabel(first.text, state) ||
        first.text.trim().split("\n")[0] ||
        first.images?.[0]?.name)) ||
    (conversation.provider === "codex" ? "Codex" : "Kimi")
  );
}
