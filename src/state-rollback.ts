import type { AppState, ConversationState } from "./types";
/** Restore transactional UI changes without detaching objects held by native callbacks. */
export function rollbackState(
  target: AppState,
  before: AppState,
  original: AppState,
): void {
  const liveConversationKeys: (keyof ConversationState)[] = [
    "nativeId",
    "status",
    "messages",
    "turns",
    "tools",
    "pendingPermissions",
    "metadata",
    "error",
    "historyPartial",
    "completionRevision",
  ];
  const restore = <T extends { id: string }>(
    saved: T[],
    references: T[],
    liveKeys: string[] = [],
  ): T[] =>
    saved.map((value) => {
      const existing = references.find((item) => item.id === value.id);
      if (!existing) return value;
      const current = existing as unknown as Record<string, unknown>;
      const keep = Object.fromEntries(
        liveKeys.map((key) => [key, current[key]]),
      );
      for (const key of Object.keys(current)) delete current[key];
      Object.assign(current, value, keep);
      return existing;
    });
  Object.assign(target, before, {
    workspaces: restore(before.workspaces, original.workspaces),
    conversations: restore(
      before.conversations,
      original.conversations,
      liveConversationKeys,
    ),
    browsers: restore(before.browsers, original.browsers),
    terminals: restore(before.terminals, original.terminals, [
      "status",
      "pid",
      "output",
      "sequence",
      "exitCode",
      "error",
      "cols",
      "rows",
    ]),
  });
}
