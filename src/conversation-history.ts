import { createHash } from "node:crypto";
import { codexQuestions } from "./codex-questions.ts";
import type { ImageAttachment, ProviderEvent } from "./providers/types";
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
  turnId?: string;
  turnCount?: number;
  imageDigests?: Map<string, string[]>;
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
      const historyTurnId = `codex/${nativeId}/${turnId}`;
      if (item.type === "userMessage") {
        const content = Array.isArray(item.content) ? item.content : [];
        const images = content
          .map(object)
          .filter((entry) => entry.type === "image");
        const digests = images.map((entry) => text(entry.historyDigest));
        if (digests.length && digests.every((digest) => digest !== undefined))
          (staged.imageDigests ??= new Map()).set(id, digests);
        const parts = content.map((entryValue) => {
          const entry = object(entryValue);
          return (
            text(entry.text) ??
            `[Native ${text(entry.type) ?? "non-text"} content]`
          );
        });
        staged.messages.push({
          id,
          turnId: historyTurnId,
          role: "user",
          text: parts.join("\n"),
          order,
        });
      } else if (item.type === "agentMessage") {
        const questions = codexQuestions(itemId, item.questions);
        staged.messages.push({
          ...(questions.length ? { questions } : {}),
          id,
          turnId: historyTurnId,
          phase:
            item.phase === "commentary"
              ? "commentary"
              : item.phase === "partial_answer"
                ? "partial"
                : item.phase === "final_answer"
                  ? "final"
                  : undefined,
          interactive:
            Array.isArray(item.questions) && item.questions.length > 0,
          role: "assistant",
          text: text(item.text) ?? "",
          order,
        });
      } else {
        staged.tools.push({
          id,
          turnId: historyTurnId,
          phase:
            item.type === "functionCallOutput"
              ? "completed"
              : phase(item.status),
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
    turnId: staged.turnId,
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
    if (event.role === "user" && staged.lastRole !== "user") {
      staged.turnCount = (staged.turnCount ?? 0) + 1;
      staged.turnId = `kimi/replay/turn-${staged.turnCount}`;
    }
    if (staged.lastRole === event.role && last?.role === event.role) {
      last.text += event.text;
    } else {
      staged.messages.push({
        id: `kimi/replay/message-${staged.messages.length + 1}`,
        turnId: staged.turnId,
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
      turnId: staged.turnId,
      phase: "updated",
      details: update,
      order: staged.order++,
    });
    staged.lastRole = undefined;
  }
}

export function stageClaudeHistory(
  staged: StagedHistory,
  value: unknown,
  nativeId: string,
): void {
  if (!Array.isArray(value)) return;
  const tools = new Map<string, ToolActivity>();
  const messages = new Map<string, ConversationMessage>();
  let turnId: string | undefined;
  for (const row of value.map(object)) {
    if (row.session_id !== nativeId || row.parent_tool_use_id) continue;
    const uuid = text(row.uuid);
    const message = object(row.message);
    const role = message.role;
    if (!uuid || (role !== "assistant" && role !== "user")) continue;
    const content = Array.isArray(message.content)
      ? message.content.map(object)
      : [{ type: "text", text: message.content }];
    const prose = content
      .filter((block) => block.type === "text")
      .map((block) => text(block.text) ?? "")
      .join("");
    const images: ImageAttachment[] = [];
    let imageBytes = 0;
    for (const item of content) {
      if (role === "user" && item.type === "image") {
        const source = object(item.source);
        const mimeType = source.media_type;
        const data = text(source.data);
        if (
          source.type === "base64" &&
          data &&
          images.length < 8 &&
          (mimeType === "image/png" ||
            mimeType === "image/jpeg" ||
            mimeType === "image/gif" ||
            mimeType === "image/webp") &&
          (imageBytes += Buffer.byteLength(data, "base64")) <=
            20 * 1024 * 1024 &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(data)
        )
          images.push({ mimeType, data });
        continue;
      }
      if (role === "user" && item.type === "tool_result") {
        const tool = tools.get(text(item.tool_use_id) ?? "");
        if (tool) {
          tool.phase = "completed";
          tool.details = {
            ...object(tool.details),
            output: item.content,
            status: item.is_error ? "failed" : "completed",
          };
        }
      }
    }
    const interrupted =
      /^\[Request interrupted by user(?: for tool use)?\]$/.test(prose);
    if ((prose || images.length) && !(role === "user" && interrupted)) {
      if (role === "user") turnId = `claude/${nativeId}/${uuid}`;
      const id = role === "assistant" ? (text(message.id) ?? uuid) : uuid;
      const messageId = `claude/live/${nativeId}/${id}`;
      const existing = messages.get(messageId);
      if (existing) {
        existing.text += prose;
      } else {
        const row: ConversationMessage = {
          id: messageId,
          role,
          turnId,
          text: prose,
          order: staged.order++,
          ...(images.length ? { images } : {}),
        };
        messages.set(messageId, row);
        staged.messages.push(row);
      }
    }
    if (role !== "assistant") continue;
    for (const item of content) {
      const id = text(item.id);
      if (item.type !== "tool_use" || !id || tools.has(id)) continue;
      const tool: ToolActivity = {
        id: `live/${nativeId}/${id}`,
        turnId,
        phase: "started",
        order: staged.order++,
        details: {
          toolCallId: id,
          kind: item.name,
          title: item.name,
          input: item.input,
        },
      };
      tools.set(id, tool);
      staged.tools.push(tool);
    }
  }
}

export function codexHistoryTurns(entries: unknown[]) {
  const turns = new Map<string, unknown[]>();
  for (let index = entries.length - 1; index >= 0; index--) {
    const { turnId, item, outputDeferred } = object(entries[index]);
    if (typeof turnId !== "string" || typeof object(item).id !== "string")
      throw new Error("Codex returned an invalid history item");
    const items = turns.get(turnId) ?? [];
    items.push(
      outputDeferred ? { ...object(item), outputDeferred: true } : item,
    );
    turns.set(turnId, items);
  }
  return [...turns].map(([id, items]) => ({ id, items }));
}

export function stageCodexItemsPage(
  staged: StagedHistory,
  descending: unknown[],
  nativeId: string,
): void {
  stageCodexSnapshot(
    staged,
    {
      historyMode: "paginated",
      turns: codexHistoryTurns(descending),
    },
    undefined,
    nativeId,
  );
}

type HistoryRow =
  | { message: ConversationMessage; tool?: never }
  | { message?: never; tool: ToolActivity };

function orderedRows(
  messages: ConversationMessage[],
  tools: ToolActivity[],
): HistoryRow[] {
  const rows: HistoryRow[] = [
    ...messages.map((message) => ({ message })),
    ...tools.map((tool) => ({ tool })),
  ];
  return rows.sort(
    (a, b) => (a.message ?? a.tool).order - (b.message ?? b.tool).order,
  );
}

function mergeCodexPage(
  conversation: ConversationState,
  staged: StagedHistory,
  matches: Map<string, string>,
  earlier: boolean,
): void {
  const cached = orderedRows(conversation.messages, conversation.tools);
  const positions = new Map(
    cached.map((row, index) => [(row.message ?? row.tool).id, index]),
  );
  const replaced = new Set(matches.values());
  const rows: HistoryRow[] = [];
  const pending: HistoryRow[] = [];
  let cacheIndex = 0;
  const takeCached = (end: number) => {
    while (cacheIndex < end) {
      const row = cached[cacheIndex++]!;
      if (!replaced.has((row.message ?? row.tool).id)) rows.push(row);
    }
  };
  for (const row of orderedRows(staged.messages, staged.tools)) {
    const match = matches.get((row.message ?? row.tool).id);
    const position = match === undefined ? undefined : positions.get(match);
    if (position === undefined) {
      pending.push(row);
      continue;
    }
    takeCached(position + 1);
    const cachedRow = cached[position]!;
    rows.push(
      ...pending.splice(0),
      earlier && (cachedRow.message ?? cachedRow.tool).id.includes("/")
        ? cachedRow
        : row,
    );
  }
  if (earlier) rows.push(...pending.splice(0));
  takeCached(cached.length);
  rows.push(...pending);
  conversation.messages = [];
  conversation.tools = [];
  rows.forEach(({ message, tool }, order) => {
    if (message) conversation.messages.push({ ...message, order });
    else conversation.tools.push({ ...tool, order });
  });
}

export function commitHistory(
  conversation: ConversationState,
  staged: StagedHistory,
  earlier = false,
): void {
  const application = conversation.messages.filter(
    (message) => message.origin === "application",
  );
  const native = staged.messages;
  // Native replay may omit image bytes. Preserve local image payloads only when
  // one unambiguous user prompt in each history identifies the same message.
  const prompt = (value: string) =>
    value
      .replace(/\[Native [^\]]+ content\]/g, "")
      .replace(/(?:\s*\[Image \d+\]\s*)+$/g, "")
      .trim();
  const cachedImages = staged.partial
    ? []
    : conversation.messages.filter(
        (message) => message.role === "user" && message.images?.length,
      );
  for (const message of native) {
    if (
      !cachedImages.length ||
      message.role !== "user" ||
      message.images?.length
    )
      continue;
    const matches = cachedImages.filter(
      (cached) => prompt(cached.text) === prompt(message.text),
    );
    if (
      matches.length === 1 &&
      native.filter(
        (other) =>
          other.role === "user" && prompt(other.text) === prompt(message.text),
      ).length === 1
    ) {
      message.images = matches[0]!.images;
      message.text = matches[0]!.text;
    }
  }
  const matches = new Map<string, string>();
  const turnLinks = new Map<string, string>();
  const ambiguous = new Set<string>();
  const link = (
    nativeTurn: string | undefined,
    localTurn: string | undefined,
  ) => {
    if (!nativeTurn || !localTurn) return;
    if (turnLinks.has(nativeTurn) && turnLinks.get(nativeTurn) !== localTurn)
      ambiguous.add(nativeTurn);
    else turnLinks.set(nativeTurn, localTurn);
  };
  const itemId = (id: string) => id.slice(id.lastIndexOf("/") + 1);
  const codex = conversation.provider === "codex";
  const cachedMessages = new Map(
    conversation.messages.map((row) => [row.id, row]),
  );
  const cachedTools = new Map(conversation.tools.map((row) => [row.id, row]));
  for (const cached of [...conversation.messages, ...conversation.tools]) {
    const canonical = /^codex\/[^/]+\/[^/]+\/[^/]+$/.test(cached.id);
    if (canonical && !cached.id.startsWith("codex/live/"))
      link(cached.id.slice(0, cached.id.lastIndexOf("/")), cached.turnId);
  }
  for (const tool of staged.tools) {
    const candidates = codex
      ? []
      : conversation.tools.filter((row) => itemId(row.id) === itemId(tool.id));
    const cached = codex
      ? (cachedTools.get(tool.id) ??
        cachedTools.get(`live/${conversation.nativeId}/${itemId(tool.id)}`))
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (cached) {
      link(tool.turnId, cached.turnId);
      matches.set(tool.id, cached.id);
    }
  }
  if (codex || conversation.provider === "claude") {
    for (const message of native) {
      const cached =
        cachedMessages.get(message.id) ??
        cachedMessages.get(
          `${conversation.provider}/live/${conversation.nativeId}/${itemId(message.id)}`,
        );
      if (cached) {
        link(message.turnId, cached.turnId);
        matches.set(message.id, cached.id);
      }
    }
  }
  const cachedImageDigests = new Map<string, string[]>();
  const imageDigests = (message: ConversationMessage) => {
    let digests = cachedImageDigests.get(message.id);
    if (!digests) {
      digests = (message.images ?? []).map(({ mimeType, data }) =>
        createHash("sha256")
          .update(`data:${mimeType};base64,`)
          .update(data)
          .digest("hex"),
      );
      cachedImageDigests.set(message.id, digests);
    }
    return digests;
  };
  for (const message of native) {
    const linkedTurn =
      message.turnId && !ambiguous.has(message.turnId)
        ? turnLinks.get(message.turnId)
        : undefined;
    const byItem = matches.get(message.id);
    const samePrompt = (other: ConversationMessage) =>
      other.role === message.role &&
      prompt(other.text) === prompt(message.text);
    const sameText = conversation.messages.filter(
      (cached) =>
        samePrompt(cached) &&
        (!staged.partial ||
          (message.role === "user" &&
            !cached.id.includes("/") &&
            linkedTurn &&
            cached.turnId === linkedTurn)),
    );
    // A provider failure can leave an image prompt as the sole row of the turn.
    // Without sibling item identities, its exact image payload distinguishes
    // it from other cached prompts that have the same text.
    const digests = staged.imageDigests?.get(message.id);
    const equalDigests = (other: string[] | undefined) =>
      digests !== undefined &&
      other?.length === digests.length &&
      other.every((digest, index) => digest === digests[index]);
    const imageMatches =
      staged.partial && !earlier && !byItem && !linkedTurn && digests
        ? conversation.messages.filter(
            (other) =>
              other.images?.length === digests.length &&
              samePrompt(other) &&
              equalDigests(imageDigests(other)),
          )
        : [];
    const imageMatch = imageMatches[0];
    const uniquelyIdentifiedImage =
      imageMatch &&
      imageMatches.length === 1 &&
      !imageMatch.id.includes("/") &&
      native.filter(
        (other) =>
          samePrompt(other) && equalDigests(staged.imageDigests?.get(other.id)),
      ).length === 1
        ? imageMatch
        : undefined;
    const cached = byItem
      ? cachedMessages.get(byItem)
      : sameText.length === 1 &&
          native.filter(
            (other) =>
              samePrompt(other) &&
              (!staged.partial || other.turnId === message.turnId),
          ).length === 1
        ? sameText[0]
        : uniquelyIdentifiedImage;
    if (cached) {
      link(message.turnId, cached.turnId);
      matches.set(message.id, cached.id);
      if ((byItem || staged.partial) && cached.images?.length) {
        message.images = cached.images;
        message.text = cached.text;
      }
      message.phase ??= cached.phase;
      message.questions ??= cached.questions;
      message.interactive ||= cached.interactive;
    }
  }
  for (const item of [...native, ...staged.tools]) {
    if (item.turnId && !ambiguous.has(item.turnId))
      item.turnId = turnLinks.get(item.turnId) ?? item.turnId;
  }
  if (staged.partial && codex) {
    mergeCodexPage(conversation, staged, matches, earlier);
    conversation.historyPartial = true;
    return;
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
