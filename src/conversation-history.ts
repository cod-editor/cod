import type { ProviderEvent } from "./providers/types";
import type {
  ConversationMessage,
  ConversationState,
  ToolActivity,
} from "./types";

export interface StagedHistory {
  messages: ConversationMessage[];
  tools: ToolActivity[];
  partial: boolean;
  order: number;
  lastRole?: "user" | "assistant";
}

export function emptyHistory(): StagedHistory {
  return { messages: [], tools: [], partial: false, order: 0 };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function phase(value: unknown): ToolActivity["phase"] {
  return value === "completed" || value === "failed" ? "completed" : "updated";
}

export function stageCodexSnapshot(
  staged: StagedHistory,
  value: unknown,
  metadata: unknown,
  nativeId: string,
): void {
  const thread = object(value);
  const response = object(metadata);
  staged.partial =
    thread.historyMode === "paginated" ||
    Boolean(response.turnsBackwardsCursor) ||
    Boolean(response.itemsBackwardsCursor);
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const turnValue of turns) {
    const turn = object(turnValue);
    if (turn.itemsView && turn.itemsView !== "full") staged.partial = true;
    const turnId = text(turn.id) ?? "unknown-turn";
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const itemValue of items) {
      const item = object(itemValue);
      const itemId = text(item.id) ?? `item-${staged.order + 1}`;
      const id = `codex/${nativeId}/${turnId}/${itemId}`;
      const order = staged.order++;
      if (item.type === "userMessage") {
        const content = Array.isArray(item.content) ? item.content : [];
        const parts = content.map((entryValue) => {
          const entry = object(entryValue);
          return (
            text(entry.text) ??
            `[Native ${text(entry.type) ?? "non-text"} content]`
          );
        });
        staged.messages.push({
          id,
          role: "user",
          text: parts.join("\n"),
          order,
        });
      } else if (item.type === "agentMessage") {
        staged.messages.push({
          id,
          role: "assistant",
          text: text(item.text) ?? "",
          order,
        });
      } else {
        staged.tools.push({
          id,
          phase: phase(item.status),
          details: item,
          order,
        });
      }
    }
  }
}

function stageKimiTool(staged: StagedHistory, detailsValue: unknown): void {
  const details = object(detailsValue);
  const nativeId = text(details.toolCallId);
  const existing = nativeId
    ? staged.tools.find((tool) => tool.id.endsWith(`/${nativeId}`))
    : undefined;
  const merged = existing
    ? { ...object(existing.details), ...details }
    : details;
  if (existing) {
    existing.details = merged;
    existing.phase = phase(merged.status);
    return;
  }
  const id = `kimi/replay/${nativeId ?? `tool-${staged.tools.length + 1}`}`;
  staged.tools.push({
    id,
    phase: phase(details.status),
    details,
    order: staged.order++,
  });
  staged.lastRole = undefined;
}

export function stageKimiEvent(
  staged: StagedHistory,
  event: ProviderEvent,
): void {
  if (event.type === "text") {
    const last = staged.messages.at(-1);
    if (staged.lastRole === event.role && last?.role === event.role) {
      last.text += event.text;
    } else {
      staged.messages.push({
        id: `kimi/replay/message-${staged.messages.length + 1}`,
        role: event.role,
        text: event.text,
        order: staged.order++,
      });
    }
    staged.lastRole = event.role;
  } else if (event.type === "tool") {
    stageKimiTool(staged, event.details);
  } else if (event.type === "history") {
    const update = object(event.details);
    const kind = text(update.sessionUpdate) ?? "update";
    staged.tools.push({
      id: `kimi/replay/${kind}-${staged.tools.length + 1}`,
      phase: "updated",
      details: update,
      order: staged.order++,
    });
    staged.lastRole = undefined;
  }
}

export function commitHistory(
  conversation: ConversationState,
  staged: StagedHistory,
): void {
  const application = conversation.messages.filter(
    (message) => message.origin === "application",
  );
  const native = staged.messages;
  // Native replay may omit image bytes. Preserve local image payloads only when
  // one unambiguous user prompt in each history identifies the same message.
  const prompt = (value: string) =>
    value.replace(/\[Native [^\]]+ content\]/g, "").trim();
  const cachedImages = conversation.messages.filter(
    (message) => message.role === "user" && message.images?.length,
  );
  for (const message of native) {
    if (message.role !== "user" || message.images?.length) continue;
    const matches = cachedImages.filter(
      (cached) => prompt(cached.text) === prompt(message.text),
    );
    if (
      matches.length === 1 &&
      native.filter(
        (other) =>
          other.role === "user" && prompt(other.text) === prompt(message.text),
      ).length === 1
    )
      message.images = matches[0]!.images;
  }
  const tools = staged.tools;
  const lastOrder = Math.max(
    0,
    ...native.map((row) => row.order),
    ...tools.map((row) => row.order),
  );
  conversation.messages = [
    ...native,
    ...application.map((row, index) => ({
      ...row,
      order: lastOrder + index + 1,
    })),
  ];
  conversation.tools = tools;
  conversation.historyPartial = staged.partial;
}
