import { object, string } from "./transport.ts";

const childPageSize = 100;
const maxChildPages = 4;

export interface CodexChild {
  id: string;
  label?: string;
  status?: string;
}

export async function listCodexChildren(
  request: (method: string, params: unknown) => Promise<unknown>,
  parentThreadId: string,
  childId?: string,
): Promise<CodexChild[]> {
  const children = new Map<string, CodexChild>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < (childId ? 1 : maxChildPages); page++) {
    const result = object(
      await request("thread/list", {
        parentThreadId,
        limit: childId ? 1 : childPageSize,
        ...(childId
          ? { includedThreadIds: [childId] }
          : { sortKey: "updated_at" }),
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (!Array.isArray(result.data))
      throw new Error("Invalid Codex child list");
    for (const value of result.data.slice(0, childId ? 1 : childPageSize)) {
      const row = object(value);
      const id = string(row.id);
      // Older servers can accept unknown filter parameters without applying them.
      if (
        !id ||
        id === parentThreadId ||
        row.parentThreadId !== parentThreadId ||
        (childId && id !== childId)
      )
        continue;
      children.set(id, {
        id,
        label: string(row.agentNickname) ?? string(row.name),
        status: string(object(row.status).type),
      });
    }
    cursor = string(result.nextCursor);
    if (!cursor || cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  return [...children.values()];
}
