import type { ImageAttachment } from "./providers/types";
import type { AppState, ConversationState } from "./types";
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
export const trailingImageMarker = /\[Image (\d+)\]$/;

export function claudePromptText(
  text: string,
  images: readonly Pick<ImageAttachment, "reference">[] = [],
): string {
  if (!images.length) return text;
  const references = new Set(
    images.map(({ reference }, index) => reference ?? index + 1),
  );
  while (references.size) {
    const trimmed = text.trimEnd();
    const suffix = trailingImageMarker.exec(trimmed);
    if (!suffix || !references.delete(Number(suffix[1]))) break;
    text = trimmed.slice(0, suffix.index).trimEnd();
  }
  return text;
}

export function conversationLabel(
  conversation: ConversationState,
  state: AppState,
): string {
  if (conversation.displayName) return conversation.displayName;
  const first = conversation.messages.find(
    (message) => message.role === "user",
  );
  const text =
    first &&
    (conversation.provider === "claude"
      ? claudePromptText(first.text, first.images)
      : first.text);
  return (
    (first &&
      (structuredMessageLabel(first.text, state) ||
        text?.trim().split("\n")[0] ||
        first.images?.[0]?.name)) ||
    (conversation.provider === "codex"
      ? "Codex"
      : conversation.provider === "kimi"
        ? "Kimi"
        : "Claude Code")
  );
}
