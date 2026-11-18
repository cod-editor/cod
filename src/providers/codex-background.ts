import type { BackgroundActivity } from "./types";
import { object, type RpcMessage } from "./transport.ts";

const maxActivities = 64;
const resultLimit = 4096;

function bounded(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value
    ? value.slice(0, limit) + (value.length > limit ? "…" : "")
    : undefined;
}

export class CodexBackground {
  private activities = new Map<string, BackgroundActivity>();
  private legacyChildren = new Set<string>();

  private foregroundCommands = new Map<
    string,
    { activity: BackgroundActivity; turnId: string }
  >();

  finishTurn(threadId: string, message: RpcMessage) {
    if (
      message.id !== undefined ||
      message.method !== "turn/completed" ||
      message.params.threadId !== threadId
    )
      return [];
    const id = object(message.params.turn).id;
    const updates = [];
    for (const [key, entry] of this.foregroundCommands) {
      if (entry.turnId !== id) continue;
      this.foregroundCommands.delete(key);
      const update = this.update(entry.activity);
      if (update) updates.push(update);
    }
    return updates;
  }

  observe(
    threadId: string,
    message: RpcMessage,
  ): { activity: BackgroundActivity; removeId?: string } | undefined {
    if (message.id !== undefined) return;
    const { params } = message;
    const origin = params.threadId;
    if (typeof origin !== "string") return;
    const owner = origin === threadId ? undefined : this.activities.get(origin);
    if (
      owner?.kind === "agent" &&
      this.legacyChildren.has(origin) &&
      message.method === "turn/completed" &&
      owner.state === "running"
    ) {
      const turn = object(params.turn);
      const state =
        turn.status === "completed"
          ? "completed"
          : turn.status === "interrupted"
            ? "interrupted"
            : "failed";
      return this.update({
        ...owner,
        state,
        finishedAt: this.time(turn.completedAtMs),
      });
    }
    const completed = message.method === "item/completed";
    if (!completed && message.method !== "item/started") return;
    const item = object(params.item);

    if (
      origin === threadId &&
      completed &&
      item.type === "collabAgentToolCall" &&
      item.tool === "spawnAgent" &&
      item.status === "completed" &&
      item.senderThreadId === threadId &&
      Array.isArray(item.receiverThreadIds)
    ) {
      // A legacy spawn returns one child; its first snapshot is usually still
      // pending. Use the child's own terminal event once its identity is known.
      const childId =
        item.receiverThreadIds.length === 1 ? item.receiverThreadIds[0] : null;
      if (
        typeof childId !== "string" ||
        childId === threadId ||
        this.activities.has(childId)
      )
        return;
      const update = this.update({
        id: childId,
        kind: "agent",
        label: "Subagent",
        state: "running",
        startedAt: this.time(item.startedAtMs),
      });
      if (update) this.legacyChildren.add(childId);
      return update;
    }

    if (origin === threadId && item.type === "subAgentActivity") {
      const childId = item.agentThreadId;
      if (typeof childId !== "string" || childId === threadId) return;
      const previous = this.activities.get(childId);
      if (item.kind === "started" && !previous) {
        return this.update({
          id: childId,
          kind: "agent",
          label: bounded(item.agentPath, 160) ?? "Subagent",
          state: "running",
          startedAt: this.time(item.startedAtMs),
        });
      }
      if (
        previous?.state === "running" &&
        completed &&
        (item.kind === "completed" || item.kind === "interrupted")
      ) {
        return this.update({
          ...previous,
          state: item.kind === "completed" ? "completed" : "interrupted",
          finishedAt: this.time(item.completedAtMs),
        });
      }
      return;
    }

    if (
      owner &&
      item.type === "agentMessage" &&
      completed &&
      item.phase !== "commentary"
    ) {
      const result = bounded(item.text, resultLimit);
      if (result && owner.result !== result)
        return this.update({ ...owner, result });
      return;
    }
    if (item.type !== "commandExecution" || typeof item.id !== "string") return;
    const id = `${origin}/${item.id}`;
    const previous = this.activities.get(id);
    if (completed) {
      this.foregroundCommands.delete(id);
      if (previous?.state !== "running") return;
      return this.update({
        ...previous,
        state:
          item.status === "completed"
            ? "completed"
            : item.status === "failed"
              ? "failed"
              : "interrupted",
        finishedAt: this.time(item.completedAtMs),
        result: bounded(item.aggregatedOutput, resultLimit),
        exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
      });
    }
    if (
      previous ||
      item.status !== "inProgress" ||
      (origin !== threadId && owner?.kind !== "agent")
    )
      return;
    const activity: BackgroundActivity = {
      id,
      kind: "command",
      owner: owner?.label,
      label: bounded(item.command, 240) ?? "Shell command",
      state: "running",
      startedAt: this.time(item.startedAtMs),
    };
    if (owner) return this.update(activity);
    // Ordinary foreground commands belong in turn history. A command that
    // remains open when its parent turn ends also belongs in background activity.
    if (
      typeof params.turnId === "string" &&
      this.foregroundCommands.size < maxActivities
    )
      this.foregroundCommands.set(id, { activity, turnId: params.turnId });
    return undefined;
  }

  private time(value: unknown) {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : Date.now();
  }

  private update(activity: BackgroundActivity) {
    let removeId: string | undefined;
    if (
      !this.activities.has(activity.id) &&
      this.activities.size >= maxActivities
    ) {
      const inactive = [...this.activities.values()].find(
        (item) => item.state !== "running",
      );
      if (!inactive) return;
      removeId = inactive.id;
      this.activities.delete(removeId);
      this.legacyChildren.delete(removeId);
    }
    this.activities.set(activity.id, activity);
    return { activity, removeId };
  }
}
