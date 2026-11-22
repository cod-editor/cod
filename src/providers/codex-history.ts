import {
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

async function readPage(
  rpc: RpcTransport,
  method: "thread/turns/list" | "thread/items/list",
  params: Record<string, unknown>,
  pageSize: number,
): Promise<Record<string, unknown>> {
  let limit = pageSize;
  for (;;) {
    try {
      return object(
        await rpc.request(method, { ...params, limit }, undefined, "history"),
      );
    } catch (error) {
      if (!(error instanceof ProviderHistoryFrameTooLarge) || limit === 1)
        throw error;
      limit = Math.floor(limit / 2);
    }
  }
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
    const page = await readPage(
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
          return [...items].reverse().map((item) => ({ turnId: id, item }));
        }),
        nextCursor: turn ? JSON.stringify({ turn }) : undefined,
      };
    const turnId = string(turns[0]?.id);
    if (!turnId)
      throw new Error("Codex returned a history turn without identity");
    items = { turnId, cursor: "" };
  }
  const page = await readPage(
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
    items: page.data,
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
