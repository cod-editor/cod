import { createHash } from "node:crypto";
import {
  inlineImageUrl,
  object,
  ProviderHistoryFrameTooLarge,
  string,
  type RpcTransport,
} from "./transport.ts";

type HistoryCursor = {
  turn?: string;
  items?: { turnId: string; cursor: string };
};

type HistoryPage = {
  items: unknown[];
  nextCursor?: string;
};

export async function readCodexHistoryPage(
  rpc: RpcTransport,
  method: "thread/turns/list" | "thread/items/list",
  params: Record<string, unknown>,
  pageSize: number,
): Promise<Record<string, unknown>> {
  let limit = pageSize;
  for (;;) {
    try {
      return object(
        await rpc.request(
          method,
          { ...params, limit },
          undefined,
          limit === 1 ? "history-with-images" : "history",
        ),
      );
    } catch (error) {
      if (!(error instanceof ProviderHistoryFrameTooLarge) || limit === 1)
        throw error;
      limit = Math.floor(limit / 2);
    }
  }
}

// The chat already owns locally attached bytes. Native replay needs only the
// input kind, and forwarding data URLs would overflow detached owner frames.
function compactHistoryItem(value: unknown): unknown {
  const item = object(value);
  if (item.type !== "userMessage" || !Array.isArray(item.content)) return value;
  return {
    ...item,
    content: item.content.map((entry) => {
      const url = inlineImageUrl(entry);
      return url
        ? {
            type: "image",
            historyDigest: createHash("sha256").update(url).digest("hex"),
          }
        : entry;
    }),
  };
}

export async function codexHistoryPage(
  rpc: RpcTransport,
  threadId: string,
  paginated: boolean,
  cursor?: string,
): Promise<HistoryPage> {
  const position: HistoryCursor = cursor ? JSON.parse(cursor) : {};
  let turn = position.turn;
  let items = position.items;
  if (!items) {
    const page = await readCodexHistoryPage(
      rpc,
      "thread/turns/list",
      {
        threadId,
        cursor: turn,
        sortDirection: "desc",
        itemsView: paginated ? "notLoaded" : "full",
      },
      paginated ? 1 : 6,
    );
    const nextTurn = string(page.nextCursor);
    if (!Array.isArray(page.data) || (nextTurn && nextTurn === turn))
      throw new Error("Codex returned an invalid turn history page");
    const turns = page.data.map(object);
    turn = nextTurn;
    if (!paginated || turns.length === 0)
      return {
        items: turns.flatMap(({ id, items }) => {
          if (typeof id !== "string" || !Array.isArray(items))
            throw new Error("Codex returned an invalid history turn");
          return [...items].reverse().map((item) => ({
            turnId: id,
            item: compactHistoryItem(item),
          }));
        }),
        nextCursor: turn ? JSON.stringify({ turn }) : undefined,
      };
    const turnId = string(turns[0]?.id);
    if (!turnId)
      throw new Error("Codex returned a history turn without identity");
    items = { turnId, cursor: "" };
  }
  const page = await readCodexHistoryPage(
    rpc,
    "thread/items/list",
    {
      threadId,
      turnId: items.turnId,
      cursor: items.cursor || undefined,
      sortDirection: "desc",
      deferOutput: { commandExecution: true, mcpToolCall: true },
    },
    30,
  );
  const nextItems = string(page.nextCursor);
  if (!Array.isArray(page.data) || (nextItems && nextItems === items.cursor))
    throw new Error("Codex returned an invalid item history page");
  return {
    items: page.data.map((value) => {
      const entry = object(value);
      return { ...entry, item: compactHistoryItem(entry.item) };
    }),
    nextCursor:
      turn || nextItems
        ? JSON.stringify({
            turn,
            items: nextItems
              ? { turnId: items.turnId, cursor: nextItems }
              : undefined,
          })
        : undefined,
  };
}
