import { randomUUID } from "node:crypto";
import {
  mkdir,
  chmod,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  capture,
  anchor,
  type Anchor,
  type Range,
  type Snapshot,
  type Target,
} from "./snapshots.ts";
interface Comment {
  id: string;
  body: string;
  anchor: Anchor;
  quote: string;
  outdated: boolean;
  history: Anchor[];
}
interface Submission {
  id: string;
  requestId: string;
  conversationId: string;
  envelope: string;
  delivery: {
    status: "queued" | "dispatching" | "acknowledged" | "uncertain";
    receipt?: Record<string, string>;
    reason?: string;
  };
}
interface Round {
  id: string;
  number: number;
  snapshotId: string;
  status: "draft" | "submitted";
  comments: Comment[];
  submission?: Submission;
}
interface Review {
  scopeFolders?: string[];
  originConversationId?: string;
  id: string;
  workspaceId: string;
  target: Target;
  version: number;
  currentRoundId: string;
  rounds: Round[];
}
interface State {
  schema: 1;
  reviews: Record<string, Review>;
  snapshots: Record<string, Snapshot>;
}
interface Options {
  dataDirectory: string;
  workspaceFolders: (workspaceId: string) => Promise<string[]>;
  conversationWorkspace: (
    conversationId: string,
  ) => Promise<string | undefined>;
  maxStorageBytes?: number;
}
interface Mutation {
  id: string;
  roundId: string;
  expectedVersion: number;
}
interface DeliveryTarget {
  id: string;
  roundId: string;
  submissionId: string;
}
const clone = <T>(value: T): T => structuredClone(value);
const validBody = (body: string) => {
  if (
    typeof body !== "string" ||
    !body.trim() ||
    Buffer.byteLength(body) > 16384
  )
    throw new Error("Comment must contain 1-16384 UTF-8 bytes");
};
export class ReviewService {
  private state: State = { schema: 1, reviews: {}, snapshots: {} };
  private ready: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private directory: string;
  private file: string;
  private quota: number;
  private options: Options;
  constructor(options: Options) {
    this.options = options;
    if (!path.isAbsolute(options.dataDirectory))
      throw new Error("Private review directory must be absolute");
    this.directory = path.join(options.dataDirectory, "reviews");
    this.file = path.join(this.directory, "state.json");
    this.quota = options.maxStorageBytes ?? 64 * 1024 * 1024;
    if (
      !Number.isInteger(this.quota) ||
      this.quota < 1024 ||
      this.quota > 64 * 1024 * 1024
    )
      throw new Error("Invalid review storage quota");
    this.ready = this.load();
    this.ready.catch(() => {});
  }
  private async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      if ((await stat(this.file)).size > this.quota)
        throw new Error("Review storage exceeds quota");
      const state = JSON.parse(await readFile(this.file, "utf8")) as State;
      if (state.schema !== 1 || !state.reviews || !state.snapshots)
        throw new Error("Unsupported review storage");
      this.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let recovered = false;
    for (const review of Object.values(this.state.reviews))
      for (const round of review.rounds)
        if (round.submission?.delivery.status === "dispatching") {
          // Keep recovery smaller than dispatching so a full valid store remains readable.
          // The UI explains uncertain status; no extra persisted prose is needed.
          round.submission.delivery = { status: "uncertain" };
          review.version++;
          recovered = true;
        }
    if (recovered) await this.persist(this.state);
  }
  private async persist(state: State) {
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > this.quota)
      throw new Error("Review storage quota exceeded");
    const temporary = path.join(this.directory, `.state-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async read() {
    await this.ready;
    await this.tail;
    return this.state;
  }
  private mutate<T>(operation: (next: State) => T | Promise<T>): Promise<T> {
    const job = this.tail.then(async () => {
      await this.ready;
      const next = clone(this.state);
      const result = await operation(next);
      await this.persist(next);
      this.state = next;
      return clone(result);
    });
    this.tail = job.catch(() => {});
    return job;
  }
  private review(state: State, id: string) {
    const review = state.reviews[id];
    if (!review) throw new Error("Unknown review");
    return review;
  }
  private round(review: Review, id: string) {
    const round = review.rounds.find((round) => round.id === id);
    if (!round) throw new Error("Unknown review round");
    return round;
  }
  private editable(state: State, args: Mutation) {
    const review = this.review(state, args.id);
    if (review.version !== args.expectedVersion)
      throw new Error("Stale review version");
    const round = this.round(review, args.roundId);
    if (round.status !== "draft" || round.id !== review.currentRoundId)
      throw new Error("Only the current draft round is editable");
    return { review, round };
  }
  private summary(review: Review) {
    const current = this.round(review, review.currentRoundId);
    return {
      id: review.id,
      workspaceId: review.workspaceId,
      originConversationId: review.originConversationId,
      target: clone(review.target),
      version: review.version,
      currentRoundId: current.id,
      snapshotId: current.snapshotId,
      status: current.status,
      rounds: review.rounds.map((round) => ({
        id: round.id,
        number: round.number,
        snapshotId: round.snapshotId,
        status: round.status,
        commentCount: round.comments.length,
        outdatedCount: round.comments.filter((comment) => comment.outdated)
          .length,
        ...(round.submission ? { submission: clone(round.submission) } : {}),
      })),
    };
  }
  async relocateOrigin(
    conversationId: string,
    workspaceId: string,
  ): Promise<void> {
    const matching = Object.values((await this.read()).reviews).some(
      (review) =>
        review.originConversationId === conversationId &&
        review.workspaceId !== workspaceId,
    );
    if (!matching) return;
    await this.mutate(async (state) => {
      for (const review of Object.values(state.reviews)) {
        if (
          review.originConversationId !== conversationId ||
          review.workspaceId === workspaceId
        )
          continue;
        review.scopeFolders ??= await this.options.workspaceFolders(
          review.workspaceId,
        );
        review.workspaceId = workspaceId;
        review.version++;
      }
    });
  }
  async reconcileOrigins(): Promise<void> {
    for (const review of Object.values((await this.read()).reviews)) {
      if (!review.originConversationId) continue;
      const workspaceId = await this.options.conversationWorkspace(
        review.originConversationId,
      );
      if (workspaceId && workspaceId !== review.workspaceId)
        await this.relocateOrigin(review.originConversationId, workspaceId);
    }
  }
  async inspect(id: string) {
    return this.summary(this.review(await this.read(), id));
  }
  async list(workspaceId?: string) {
    return Object.values((await this.read()).reviews)
      .filter(
        (review) =>
          workspaceId === undefined || review.workspaceId === workspaceId,
      )
      .map((review) => this.summary(review));
  }
  async detail(id: string) {
    const state = await this.read(),
      review = this.review(state, id);
    const snapshots: Record<string, Snapshot> = {};
    for (const round of review.rounds) {
      snapshots[round.snapshotId] = state.snapshots[round.snapshotId];
      for (const comment of round.comments) {
        snapshots[comment.anchor.snapshotId] =
          state.snapshots[comment.anchor.snapshotId];
        for (const previous of comment.history)
          snapshots[previous.snapshotId] = state.snapshots[previous.snapshotId];
      }
    }
    return clone({ ...review, snapshots });
  }
  private openReview(
    workspaceId: string,
    target: Target,
    originConversationId?: string,
  ) {
    return this.mutate(async (state) => {
      if (
        originConversationId &&
        (await this.options.conversationWorkspace(originConversationId)) !==
          workspaceId
      )
        throw new Error("Review origin must belong to workspace");
      const captured = await capture(
        target,
        await this.options.workspaceFolders(workspaceId),
      );
      const round: Round = {
        id: randomUUID(),
        number: 1,
        snapshotId: captured.snapshot.id,
        status: "draft",
        comments: [],
      };
      const review: Review = {
        id: randomUUID(),
        workspaceId,
        originConversationId,
        target: captured.target,
        version: 1,
        currentRoundId: round.id,
        rounds: [round],
      };
      state.snapshots[captured.snapshot.id] = captured.snapshot;
      state.reviews[review.id] = review;
      return this.summary(review);
    });
  }
  openDocument(args: {
    workspaceId: string;
    path: string;
    originConversationId?: string;
  }) {
    return this.openReview(
      args.workspaceId,
      {
        kind: "document",
        path: args.path,
      },
      args.originConversationId,
    );
  }
  openDiff(args: {
    workspaceId: string;
    originConversationId?: string;
    repoRoot: string;
    base?: string;
    head?: string;
  }) {
    return this.openReview(
      args.workspaceId,
      {
        kind: "diff",
        repoRoot: args.repoRoot,
        ...(args.base !== undefined ? { base: args.base } : {}),
        ...(args.head !== undefined ? { head: args.head } : {}),
      },
      args.originConversationId,
    );
  }
  addComment(args: Mutation & { body: string; range: Range }) {
    return this.mutate((state) => {
      validBody(args.body);
      const { review, round } = this.editable(state, args);
      if (round.comments.length >= 100)
        throw new Error("Review round comment limit exceeded");
      const selected = anchor(
        state.snapshots[round.snapshotId],
        review.target,
        args.range,
      );
      round.comments.push({
        id: randomUUID(),
        body: args.body,
        ...selected,
        outdated: false,
        history: [],
      });
      review.version++;
      return this.summary(review);
    });
  }
  editComment(args: Mutation & { commentId: string; body: string }) {
    return this.mutate((state) => {
      validBody(args.body);
      const { review, round } = this.editable(state, args);
      const comment = round.comments.find(
        (comment) => comment.id === args.commentId,
      );
      if (!comment) throw new Error("Unknown comment");
      comment.body = args.body;
      review.version++;
      return this.summary(review);
    });
  }
  deleteComment(args: Mutation & { commentId: string }) {
    return this.mutate((state) => {
      const { review, round } = this.editable(state, args);
      const index = round.comments.findIndex(
        (comment) => comment.id === args.commentId,
      );
      if (index < 0) throw new Error("Unknown comment");
      round.comments.splice(index, 1);
      review.version++;
      return this.summary(review);
    });
  }
  reanchorComment(args: Mutation & { commentId: string; range: Range }) {
    return this.mutate((state) => {
      const { review, round } = this.editable(state, args);
      const comment = round.comments.find(
        (comment) => comment.id === args.commentId,
      );
      if (!comment) throw new Error("Unknown comment");
      const selected = anchor(
        state.snapshots[round.snapshotId],
        review.target,
        args.range,
      );
      comment.history.push(clone(comment.anchor));
      Object.assign(comment, selected, { outdated: false });
      review.version++;
      return this.summary(review);
    });
  }
  refresh(args: {
    id: string;
    expectedRoundId: string;
    expectedVersion: number;
  }) {
    return this.mutate(async (state) => {
      const review = this.review(state, args.id);
      if (
        review.version !== args.expectedVersion ||
        review.currentRoundId !== args.expectedRoundId
      )
        throw new Error("Stale review round/version");
      const old = this.round(review, review.currentRoundId);
      const captured = await capture(
        review.target,
        review.scopeFolders ??
          (await this.options.workspaceFolders(review.workspaceId)),
      );
      const next: Round = {
        id: randomUUID(),
        number: old.number + 1,
        snapshotId: captured.snapshot.id,
        status: "draft",
        comments:
          old.status === "draft"
            ? old.comments.map((comment) => ({
                ...clone(comment),
                outdated: true,
              }))
            : [],
      };
      review.rounds.push(next);
      review.currentRoundId = next.id;
      review.version++;
      state.snapshots[captured.snapshot.id] = captured.snapshot;
      return this.summary(review);
    });
  }
  async changed(id: string) {
    const state = await this.read(),
      review = this.review(state, id),
      saved =
        state.snapshots[this.round(review, review.currentRoundId).snapshotId];
    try {
      const current = await capture(
        review.target,
        review.scopeFolders ??
          (await this.options.workspaceFolders(review.workspaceId)),
      );
      return {
        changed:
          current.snapshot.hash !== saved.hash ||
          current.snapshot.base !== saved.base ||
          current.snapshot.head !== saved.head,
        unavailable: false,
      };
    } catch {
      return { changed: true, unavailable: true };
    }
  }
  async documentChanges(id: string) {
    const state = await this.read(),
      review = this.review(state, id);
    if (review.target.kind !== "document" || review.rounds.length < 2)
      throw new Error("Two document rounds are required");
    const previous = state.snapshots[review.rounds.at(-2)!.snapshotId],
      current = state.snapshots[review.rounds.at(-1)!.snapshotId];
    const old = previous.text.match(/[^\n]*\n|[^\n]+$/g) ?? [],
      next = current.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const changes: Array<{
      type: "equal" | "delete" | "insert";
      lines: string[];
    }> = [];
    const add = (type: "equal" | "delete" | "insert", line: string) => {
      const last = changes.at(-1);
      if (last?.type === type) last.lines.push(line);
      else changes.push({ type, lines: [line] });
    };
    if ((old.length + 1) * (next.length + 1) <= 1_000_000) {
      const width = next.length + 1,
        table = new Uint32Array((old.length + 1) * width);
      for (let i = old.length - 1; i >= 0; i--)
        for (let j = next.length - 1; j >= 0; j--)
          table[i * width + j] =
            old[i] === next[j]
              ? 1 + table[(i + 1) * width + j + 1]
              : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      let i = 0,
        j = 0;
      while (i < old.length || j < next.length) {
        if (i < old.length && j < next.length && old[i] === next[j]) {
          add("equal", old[i++]);
          j++;
        } else if (
          i < old.length &&
          (j === next.length ||
            table[(i + 1) * width + j] >= table[i * width + j + 1])
        )
          add("delete", old[i++]);
        else add("insert", next[j++]);
      }
    } else {
      let prefix = 0,
        suffix = 0;
      while (
        prefix < old.length &&
        prefix < next.length &&
        old[prefix] === next[prefix]
      )
        prefix++;
      while (
        suffix < old.length - prefix &&
        suffix < next.length - prefix &&
        old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
      )
        suffix++;
      for (const line of old.slice(0, prefix)) add("equal", line);
      for (const line of old.slice(prefix, old.length - suffix))
        add("delete", line);
      for (const line of next.slice(prefix, next.length - suffix))
        add("insert", line);
      if (suffix) for (const line of old.slice(-suffix)) add("equal", line);
    }
    return {
      previousSnapshotId: previous.id,
      currentSnapshotId: current.id,
      before: previous.text,
      after: current.text,
      changes,
    };
  }
  submit(args: Mutation & { conversationId: string; requestId: string }) {
    return this.mutate(async (state) => {
      if (!args.requestId || args.requestId.length > 128)
        throw new Error("Submission request ID required");
      for (const review of Object.values(state.reviews))
        for (const round of review.rounds) {
          const submission = round.submission;
          if (submission?.requestId === args.requestId) {
            if (
              review.id !== args.id ||
              round.id !== args.roundId ||
              submission.conversationId !== args.conversationId
            )
              throw new Error(
                "Submission request ID reused with different target",
              );
            return submission;
          }
        }
      const { review, round } = this.editable(state, args);
      if (
        review.originConversationId &&
        review.originConversationId !== args.conversationId
      )
        throw new Error("Feedback must return to the originating conversation");
      if (
        (await this.options.conversationWorkspace(args.conversationId)) !==
        review.workspaceId
      )
        throw new Error(
          "Destination conversation must belong to review workspace",
        );
      const snapshot = state.snapshots[round.snapshotId],
        id = randomUUID();
      const envelope = JSON.stringify({
        reviewId: review.id,
        roundId: round.id,
        submissionId: id,
        target: review.target,
        snapshot: {
          id: snapshot.id,
          hash: snapshot.hash,
          base: snapshot.base,
          head: snapshot.head,
        },
        comments: round.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          anchor: comment.anchor,
          quote: comment.quote,
          outdated: comment.outdated,
        })),
      });
      round.submission = {
        id,
        requestId: args.requestId,
        conversationId: args.conversationId,
        envelope,
        delivery: { status: "queued" },
      };
      round.status = "submitted";
      review.version++;
      return round.submission;
    });
  }
  private delivery(state: State, args: DeliveryTarget) {
    const review = this.review(state, args.id),
      round = this.round(review, args.roundId);
    if (round.submission?.id !== args.submissionId)
      throw new Error("Unknown review submission");
    return { review, submission: round.submission };
  }
  markDispatching(args: DeliveryTarget) {
    return this.mutate((state) => {
      const { review, submission } = this.delivery(state, args);
      if (submission.delivery.status !== "queued")
        throw new Error("Only definitely unsent queued feedback can dispatch");
      submission.delivery = { status: "dispatching" };
      review.version++;
      return submission;
    });
  }
  markUncertain(args: DeliveryTarget & { reason: string }) {
    return this.mutate((state) => {
      const { review, submission } = this.delivery(state, args);
      if (submission.delivery.status !== "dispatching")
        throw new Error("Only dispatching feedback can become uncertain");
      submission.delivery = {
        status: "uncertain",
        reason: args.reason.slice(0, 500),
      };
      review.version++;
      return submission;
    });
  }
  acknowledge(args: DeliveryTarget & { receipt: Record<string, string> }) {
    return this.mutate((state) => {
      const { review, submission } = this.delivery(state, args);
      if (
        !args.receipt ||
        Object.values(args.receipt).some(
          (value) => typeof value !== "string",
        ) ||
        !Object.keys(args.receipt).length ||
        Buffer.byteLength(JSON.stringify(args.receipt)) > 4096
      )
        throw new Error("A bounded verified native receipt is required");
      if (submission.delivery.status === "acknowledged") {
        if (
          JSON.stringify(submission.delivery.receipt) !==
          JSON.stringify(args.receipt)
        )
          throw new Error("Acknowledgement receipt differs");
        return submission;
      }
      if (!["dispatching", "uncertain"].includes(submission.delivery.status))
        throw new Error("Cannot acknowledge feedback that was not dispatched");
      submission.delivery = {
        status: "acknowledged",
        receipt: clone(args.receipt),
      };
      review.version++;
      return submission;
    });
  }
}
