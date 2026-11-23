import type { BackgroundActivity } from "./types";
import type { CodexChild } from "./codex-children.ts";
import { object, type RpcMessage } from "./transport.ts";

const maxActivities = 64;
const resultLimit = 4096;
const maxChildren = 400;
const maxChildLookups = 8;

type ActivityUpdate = { activity: BackgroundActivity; removeId?: string };
type ChildState = {
  state: BackgroundActivity["state"];
  at: number;
  nativeStatus?: true;
};
type KnownChild = { label: string; legacy?: true; hasStatusEvent?: true };

function statusState(status: unknown): ChildState["state"] | undefined {
  switch (status) {
    case "active":
      return "running";
    case "idle":
      return "completed";
    case "notLoaded":
      return "unknown";
    case "systemError":
      return "failed";
  }
}

function bounded(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value
    ? value.slice(0, limit) + (value.length > limit ? "…" : "")
    : undefined;
}

export class CodexBackground {
  private activities = new Map<string, BackgroundActivity>();
  private children = new Map<string, KnownChild>();
  private childLookups = new Map<string | undefined, Map<string, ChildState>>();

  async reconcileChildren(
    childId: string | undefined,
    list: () => Promise<CodexChild[]>,
    publish: (update: ActivityUpdate) => void,
    isCurrent: () => boolean,
  ) {
    if (
      this.childLookups.has(childId) ||
      this.childLookups.size >= maxChildLookups
    )
      return;
    const newer = new Map<string, ChildState>();
    this.childLookups.set(childId, newer);
    try {
      const rows = await list();
      if (!isCurrent()) return;
      for (const child of rows) {
        this.rememberChild(child.id, child.label);
        const snapshot = statusState(child.status);
        const current =
          newer.get(child.id) ??
          (snapshot ? { state: snapshot, at: Date.now() } : undefined);
        if (!current) continue;
        const update = this.applyChildState(child.id, current);
        if (update) publish(update);
      }
    } finally {
      this.childLookups.delete(childId);
    }
  }

  private rememberChild(id: string, name?: string) {
    const child = this.children.get(id);
    if (child) {
      if (child.label === "Subagent")
        child.label = bounded(name, 160) ?? child.label;
      return child;
    }
    if (this.children.size >= maxChildren) {
      const oldestInactive = [...this.children.keys()].find(
        (key) => this.activities.get(key)?.state !== "running",
      );
      if (oldestInactive) this.children.delete(oldestInactive);
    }
    const created: KnownChild = { label: bounded(name, 160) ?? "Subagent" };
    this.children.set(id, created);
    return created;
  }

  private noteChildState(id: string, state: ChildState) {
    // An in-flight list can describe a state older than a received notification.
    // Only matching, provider-confirmed child rows can use buffered statuses.
    for (const [target, lookup] of this.childLookups) {
      if (target && target !== id) continue;
      if (lookup.size >= maxChildren && !lookup.has(id)) {
        const oldest = lookup.keys().next().value;
        if (oldest) lookup.delete(oldest);
      }
      lookup.set(id, state);
    }
    return this.applyChildState(id, state);
  }

  private applyChildState(id: string, { state, at, nativeStatus }: ChildState) {
    const child = this.children.get(id);
    if (!child) return;
    if (nativeStatus) child.hasStatusEvent = true;
    const existing = this.activities.get(id);
    if (state === "running") {
      if (existing?.state === "running") return;
      return this.update({
        id,
        kind: "agent",
        state,
        label: child.label,
        startedAt: at,
      });
    }
    if (!existing || existing.state !== "running") return;
    return this.update({ ...existing, state, finishedAt: at });
  }

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
    lookupChild: (id: string) => void,
  ): ActivityUpdate | undefined {
    if (message.id !== undefined) return;
    const { params } = message;
    const origin = params.threadId;
    if (typeof origin !== "string") return;
    const child = origin === threadId ? undefined : this.children.get(origin);
    if (message.method === "thread/status/changed" && origin !== threadId) {
      const state = statusState(object(params.status).type);
      if (!state) return;
      return this.noteChildState(origin, {
        state,
        at: Date.now(),
        nativeStatus: true,
      });
    }
    const owner = child ? this.activities.get(origin) : undefined;
    if (child?.legacy && !child.hasStatusEvent) {
      const turn = object(params.turn);
      if (message.method === "turn/started")
        return this.noteChildState(origin, {
          state: "running",
          at: this.time(turn.startedAtMs),
        });
      if (message.method === "turn/completed") {
        const state =
          turn.status === "completed"
            ? "completed"
            : turn.status === "interrupted"
              ? "interrupted"
              : "failed";
        return this.noteChildState(origin, {
          state,
          at: this.time(turn.completedAtMs),
        });
      }
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
      const childId =
        item.receiverThreadIds.length === 1 ? item.receiverThreadIds[0] : null;
      if (typeof childId !== "string" || !childId || childId === threadId)
        return;
      const child = this.rememberChild(childId);
      child.legacy = true;
      if (child.hasStatusEvent) return;
      return this.noteChildState(childId, {
        state: "running",
        at: this.time(item.startedAtMs),
      });
    }

    if (origin === threadId && item.type === "subAgentActivity") {
      const childId = item.agentThreadId;
      if (typeof childId !== "string" || !childId || childId === threadId)
        return;
      if (completed && item.kind === "started") {
        const child = this.rememberChild(childId, bounded(item.agentPath, 160));
        if (child.hasStatusEvent) return;
        return this.noteChildState(childId, {
          state: "running",
          at: this.time(item.startedAtMs),
        });
      }
      if (completed && item.kind === "interacted") {
        // The provider uses this for both queued messages and resumed work.
        if (!this.children.has(childId)) lookupChild(childId);
      } else if (
        completed &&
        (item.kind === "completed" || item.kind === "interrupted")
      ) {
        // Live thread status wins over a completion that can describe a prior turn.
        const existing = this.children.get(childId);
        if (existing && !existing.hasStatusEvent)
          return this.noteChildState(childId, {
            state: item.kind === "completed" ? "completed" : "interrupted",
            at: this.time(item.completedAtMs),
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
    }
    this.activities.set(activity.id, activity);
    return { activity, removeId };
  }
}
