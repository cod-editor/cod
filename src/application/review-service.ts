import { trustedReviewOperations } from "../command-catalog";
import { randomUUID } from "node:crypto";
import { ReviewService } from "../reviews";
import type { OperationRequest } from "../types";
import { ApplicationStateStore } from "./state";
import type { ConversationApplicationService } from "./conversation-service";
import { requiredString } from "./request";
import { leaf, replaceLeaf } from "./layout";

type ReviewConversationPort = Pick<
  ConversationApplicationService,
  | "isActive"
  | "reserve"
  | "release"
  | "freshHistory"
  | "ensureReady"
  | "assertCurrent"
  | "sendReserved"
  | "isCurrent"
>;
export class ReviewApplicationService {
  private readonly reviews: ReviewService;
  private readonly reviewDispatches = new Set<string>();
  private readonly reviewJobs = new Set<Promise<unknown>>();
  constructor(
    private readonly store: ApplicationStateStore,
    private readonly conversations: ReviewConversationPort,
  ) {
    this.reviews = new ReviewService({
      dataDirectory: store.directory,
      workspaceFolders: async (id) => store.workspace(id).folders,
      conversationWorkspace: async (id) =>
        store.data.conversations.find((c) => c.id === id)?.workspaceId,
    });
  }
  list(workspace?: string) {
    return this.reviews.list(workspace);
  }
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.reviewJobs]);
  }
  async relocateOrigin(
    conversationId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.reviews.relocateOrigin(conversationId, workspaceId);
    this.store.data.reviews = await this.reviews.list();
  }
  async reconcileOrigins(): Promise<void> {
    await this.reviews.reconcileOrigins();
    this.store.data.reviews = await this.reviews.list();
  }
  async refreshReviews(): Promise<void> {
    this.store.data.reviews = await this.reviews.list();
    this.store.notify();
  }
  async reviewOperation(
    request: OperationRequest,
    trusted: boolean,
  ): Promise<unknown> {
    const privateOps: readonly string[] = trustedReviewOperations;
    if (privateOps.includes(request.op) && !trusted)
      throw new Error("Review draft access requires the trusted desktop UI");
    if (
      request.op === "review.open-document" ||
      request.op === "review.open-diff"
    ) {
      return this.store.serialize(async () => {
        const workspace = this.store.workspace(
          requiredString(request, "workspace"),
        );
        const active = workspace.panes.find(
          (pane) => pane.id === workspace.activePaneId,
        );
        const originConversationId =
          typeof request.conversation === "string"
            ? request.conversation
            : active?.kind === "conversation"
              ? active.conversationId
              : this.store.data.conversations.filter(
                    (item) => item.workspaceId === workspace.id,
                  ).length === 1
                ? this.store.data.conversations.find(
                    (item) => item.workspaceId === workspace.id,
                  )?.id
                : undefined;
        const resolvedOrigin =
          originConversationId ?? workspace.lastConversationId;
        if (!resolvedOrigin)
          throw new Error(
            "Open the review from a conversation or provide its conversation ID",
          );
        const summary =
          request.op === "review.open-document"
            ? await this.reviews.openDocument({
                workspaceId: workspace.id,
                originConversationId: resolvedOrigin,
                path: requiredString(request, "path"),
              })
            : await this.reviews.openDiff({
                workspaceId: workspace.id,
                originConversationId: resolvedOrigin,
                repoRoot: requiredString(request, "repoRoot"),
                base: request.base as string | undefined,
                head: request.head as string | undefined,
              });
        const paneId = randomUUID(),
          activeId = workspace.activePaneId;
        workspace.panes.push({
          id: paneId,
          kind: "review",
          reviewId: summary.id,
        });
        workspace.layout = replaceLeaf(workspace.layout, activeId, {
          type: "split",
          direction: "right",
          ratio: 0.5,
          first: leaf(activeId),
          second: leaf(paneId),
        });
        workspace.activePaneId = paneId;
        await this.store.persist();
        await this.refreshReviews();
        return {
          ...summary,
          reviewId: summary.id,
          roundId: summary.currentRoundId,
          paneId,
        };
      });
    }
    const id = requiredString(request, "id");
    if (request.op === "review.show")
      return this.store.change(async () => {
        const summary = await this.reviews.inspect(id),
          workspace = this.store.workspace(summary.workspaceId);
        let pane = workspace.panes.find(
          (p) => p.kind === "review" && p.reviewId === id,
        );
        if (!pane) {
          const paneId = randomUUID(),
            active = workspace.activePaneId;
          pane = { id: paneId, kind: "review", reviewId: id };
          workspace.panes.push(pane);
          workspace.layout = replaceLeaf(workspace.layout, active, {
            type: "split",
            direction: "right",
            ratio: 0.5,
            first: leaf(active),
            second: leaf(paneId),
          });
        }
        workspace.activePaneId = pane.id;
        return {
          reviewId: id,
          paneId: pane.id,
          roundId: summary.currentRoundId,
          snapshotId: summary.snapshotId,
          version: summary.version,
        };
      });
    if (request.op === "review.inspect") return this.reviews.inspect(id);
    if (request.op === "review.detail") return this.reviews.detail(id);
    if (request.op === "review.changed") return this.reviews.changed(id);
    if (request.op === "review.changes")
      return this.reviews.documentChanges(id);
    if (request.op === "review.deliver")
      return this.deliverReview(id, requiredString(request, "round"));
    const summary = await this.reviews.inspect(id);
    this.store.workspace(summary.workspaceId);
    const expectedVersion =
      request.expectedVersion === undefined
        ? summary.version
        : Number(request.expectedVersion);
    let result: unknown;
    if (request.op === "review.refresh")
      result = await this.reviews.refresh({
        id,
        expectedRoundId: requiredString(request, "expectedRound"),
        expectedVersion,
      });
    else if (request.op === "review.submit") {
      if (
        request.conversation &&
        summary.originConversationId &&
        request.conversation !== summary.originConversationId
      )
        throw new Error("Feedback must return to originating conversation");
      result = await this.reviews.submit({
        id,
        roundId: requiredString(request, "round"),
        expectedVersion,
        conversationId:
          summary.originConversationId ??
          requiredString(request, "conversation"),
        requestId: requiredString(request, "requestId"),
      });
      await this.refreshReviews();
      if (summary.originConversationId) {
        const origin = this.store.conversation(summary.originConversationId);
        if (
          origin.taskStatus === "review" &&
          !this.store.data.reviews?.some(
            (review) =>
              review.id !== id &&
              review.originConversationId === origin.id &&
              review.status === "draft",
          )
        ) {
          origin.taskStatus = undefined;
          origin.taskStatusContext = undefined;
        }
      }
      // Submission is durable before delivery starts; waiters never wait for a model turn.
      void this.deliverReview(id, requiredString(request, "round")).catch(
        () => undefined,
      );
      return result;
    } else {
      if (!trusted || !privateOps.includes(request.op))
        throw new Error("Unknown review operation");
      if (!Number.isInteger(request.expectedVersion))
        throw new Error("An expected review version is required");
      const mutation = {
        id,
        roundId: requiredString(request, "roundId"),
        expectedVersion,
      };
      const range = request.range as import("../reviews/snapshots").Range;
      switch (request.op) {
        case "review.comment-add":
          result = await this.reviews.addComment({
            ...mutation,
            body: requiredString(request, "body"),
            range,
          });
          break;
        case "review.comment-edit":
          result = await this.reviews.editComment({
            ...mutation,
            commentId: requiredString(request, "commentId"),
            body: requiredString(request, "body"),
          });
          break;
        case "review.comment-delete":
          result = await this.reviews.deleteComment({
            ...mutation,
            commentId: requiredString(request, "commentId"),
          });
          break;
        case "review.comment-reanchor":
          result = await this.reviews.reanchorComment({
            ...mutation,
            commentId: requiredString(request, "commentId"),
            range,
          });
          break;
        default:
          throw new Error("Unknown review operation");
      }
    }
    await this.refreshReviews();
    return result;
  }
  deliverReview(id: string, roundId: string): Promise<unknown> {
    const job = this.performReviewDelivery(id, roundId);
    this.reviewJobs.add(job);
    void job.finally(() => this.reviewJobs.delete(job)).catch(() => undefined);
    return job;
  }
  async performReviewDelivery(id: string, roundId: string): Promise<unknown> {
    if (this.store.closing)
      throw new Error("Cod is shutting down; feedback remains queued");
    const summary = await this.reviews.inspect(id);
    const submission = summary.rounds.find((r) => r.id === roundId)?.submission;
    if (!submission) throw new Error("Round is not submitted");
    if (
      submission.delivery.status === "acknowledged" ||
      this.reviewDispatches.has(submission.id)
    )
      return submission;
    const conversation = this.store.conversation(submission.conversationId);
    if (
      summary.originConversationId
        ? summary.originConversationId !== conversation.id
        : conversation.workspaceId !== summary.workspaceId
    )
      throw new Error("Review destination no longer belongs to workspace");
    if (
      this.conversations.isActive(conversation.id) ||
      ["working", "waiting", "starting"].includes(conversation.status)
    )
      return submission;
    if (
      submission.delivery.status === "queued" &&
      conversation.status !== "ready"
    )
      return submission;
    this.conversations.reserve(conversation.id);
    this.reviewDispatches.add(submission.id);
    const target = { id, roundId, submissionId: submission.id };
    try {
      if (submission.delivery.status === "uncertain") {
        const history = await this.conversations.freshHistory(conversation);
        const found = history.messages.find(
          (m) => m.role === "user" && m.text === submission.envelope,
        );
        if (found)
          await this.reviews.acknowledge({
            ...target,
            receipt: {
              nativeId: conversation.nativeId,
              nativeMessageId: found.id,
              evidence: "fresh-native-history",
            },
          });
        else
          throw new Error(
            "Delivery remains uncertain. Inspect the frozen feedback and native history; do not resend automatically.",
          );
      } else if (submission.delivery.status === "queued") {
        await this.conversations.ensureReady(conversation);
        this.conversations.assertCurrent(conversation);
        await this.reviews.markDispatching(target);
        await this.refreshReviews();
        try {
          this.conversations.assertCurrent(conversation);
          if (this.store.closing) throw new Error("Cod is shutting down");
          await this.conversations.sendReserved(
            conversation,
            submission.envelope,
            submission.id,
          );
          await this.reviews.acknowledge({
            ...target,
            receipt: {
              nativeId: conversation.nativeId,
              evidence: "native-turn-completed",
              submissionId: submission.id,
            },
          });
        } catch {
          await this.reviews.markUncertain({
            ...target,
            reason:
              "Native turn did not complete; it may have accepted the feedback. Reconcile native history before any resend.",
          });
        }
      }
      return (await this.reviews.inspect(id)).rounds.find(
        (r) => r.id === roundId,
      )!.submission;
    } catch (error) {
      if (
        submission.delivery.status === "queued" &&
        this.conversations.isCurrent(conversation)
      ) {
        conversation.status = "failed";
        conversation.error = `Feedback remains queued: ${error instanceof Error ? error.message : String(error)}`;
      }
      throw error;
    } finally {
      this.conversations.release(conversation.id);
      this.reviewDispatches.delete(submission.id);
      await this.refreshReviews();
      this.store.schedulePersist(true);
    }
  }

  handle(request: OperationRequest, trustedUi: boolean): Promise<unknown> {
    const mutation = [
      "review.refresh",
      "review.submit",
      "review.comment-add",
      "review.comment-edit",
      "review.comment-delete",
      "review.comment-reanchor",
    ].includes(request.op);
    return mutation
      ? this.store.serialize(() => this.reviewOperation(request, trustedUi))
      : this.reviewOperation(request, trustedUi);
  }
}
