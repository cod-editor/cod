import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { conversationHandoffReason } from "../conversation-actions";
import type { ConversationState, OperationRequest } from "../types";
import {
  installCodexRollout,
  preflightCodexRollout,
  readCodexRollout,
  type CodexRollout,
} from "../providers/codex-rollout";
import type { ConversationApplicationService } from "./conversation-service";
import type { WorkspaceApplicationService } from "./workspace-service";
import type { ApplicationStateStore } from "./state";
import { requiredString } from "./request";

export type TransferDestination = Omit<
  NonNullable<ConversationState["transfer"]>,
  "id"
>;

interface TransferReceipt {
  id: string;
  paneId: string;
  nativeId: string;
}

type TransferReply =
  | { status: "ready" }
  | { status: "moved"; receipt: TransferReceipt }
  | { status: "rejected"; reason: string };

function reason(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Conversation transfer failed";
}

export class ConversationTransferService {
  private readonly moving = new Set<string>();
  private readonly receiving = new Set<string>();

  constructor(
    private readonly store: ApplicationStateStore,
    private readonly conversations: ConversationApplicationService,
    private readonly workspaces: WorkspaceApplicationService,
  ) {}

  private checkSourceReadiness(chat: ConversationState): void {
    const blocked = conversationHandoffReason(this.store.data, chat);
    if (blocked) throw new Error(blocked);
    this.conversations.checkTransferReadiness(chat);
    if (
      chat.backgroundActivities?.some(
        (activity) => activity.state === "unknown",
      )
    )
      throw new Error(
        "Confirm unknown background activity before moving this chat",
      );
  }

  async move(
    id: string,
    destination: TransferDestination,
    receive: (request: OperationRequest) => Promise<unknown>,
  ): Promise<TransferReceipt> {
    if (this.moving.has(id))
      throw new Error("This conversation is already moving");
    this.moving.add(id);
    try {
      const original = this.store.conversation(id);
      if (original.provider !== "codex" || !original.nativeId)
        throw new Error("Only a saved Codex session can move to Linux");
      const { nativeId, cwd } = original;
      if (!original.transfer) {
        this.checkSourceReadiness(original);
        await preflightCodexRollout(nativeId, cwd);
        const checked = (await receive({
          op: "conversation.accept-transfer",
          check: true,
          nativeId,
          workspace: destination.workspace,
          cwd: destination.cwd,
        })) as TransferReply | undefined;
        if (checked?.status !== "ready")
          throw new Error(
            checked?.status === "rejected"
              ? checked.reason
              : "The Linux destination could not be verified",
          );
      }
      const prepared = await this.store.change(() => {
        const chat = this.store.conversation(id);
        if (chat.provider !== "codex" || !chat.nativeId)
          throw new Error("Only a saved Codex session can move to Linux");
        if (chat.nativeId !== nativeId || chat.cwd !== cwd)
          throw new Error("The source chat changed while checking the move");
        if (this.store.data.transferredCodexSessions?.includes(chat.nativeId))
          throw new Error("This saved Codex session was moved to Linux");
        const existing = chat.transfer;
        if (existing) {
          if (
            existing.host !== destination.host ||
            existing.workspace !== destination.workspace ||
            existing.cwd !== destination.cwd
          )
            throw new Error(
              "Reconnect to the original Linux workspace to finish this move",
            );
        } else {
          this.checkSourceReadiness(chat);
        }
        const workspace = this.store.workspace(chat.workspaceId);
        const draft = workspace.chatDrafts?.[chat.paneId];
        if (draft?.images?.length || draft?.skills?.length || draft?.localDraft)
          throw new Error(
            "Resolve this chat's draft attachments or conflict before moving it",
          );
        if (
          draft &&
          Buffer.byteLength(JSON.stringify(draft.text)) > 1024 * 1024
        )
          throw new Error("This chat draft exceeds the 1 MiB transfer limit");
        const transfer = existing ?? { id: randomUUID(), ...destination };
        chat.transfer = transfer;
        return { chat, transfer, draft: draft?.text, existing: !!existing };
      });
      const { chat, transfer } = prepared;
      const release = () =>
        this.store.change(() => {
          if (chat.transfer?.id === transfer.id) delete chat.transfer;
        });
      let rollout: CodexRollout;
      try {
        await this.conversations.disposeController(id);
        rollout = await readCodexRollout(chat.nativeId, chat.cwd);
      } catch (error) {
        if (!prepared.existing) await release();
        throw error;
      }
      const reply = (await receive({
        op: "conversation.accept-transfer",
        transferId: transfer.id,
        nativeId: chat.nativeId,
        workspace: transfer.workspace,
        cwd: transfer.cwd,
        title: chat.displayName,
        draft: prepared.draft,
        rollout,
      })) as TransferReply | undefined;
      if (reply?.status === "rejected") {
        await release();
        throw new Error(reply.reason);
      }
      if (
        reply?.status !== "moved" ||
        reply.receipt?.nativeId !== chat.nativeId
      )
        throw new Error(
          "The Linux host did not confirm this move. Retry it with the same destination.",
        );
      await this.workspaces.finishTransfer(id, transfer.id);
      return reply.receipt;
    } finally {
      this.moving.delete(id);
    }
  }

  async accept(request: OperationRequest): Promise<TransferReply> {
    const transferId =
      request.check === true
        ? undefined
        : requiredString(request, "transferId");
    const nativeId = requiredString(request, "nativeId");
    const workspaceId = requiredString(request, "workspace");
    const requestedCwd = requiredString(request, "cwd");
    for (const value of transferId ? [transferId, nativeId] : [nativeId])
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value))
        throw new Error("Invalid Codex transfer identity");
    if (this.receiving.has(nativeId))
      throw new Error("The destination is still receiving this Codex session");
    this.receiving.add(nativeId);
    try {
      const completed = transferId
        ? this.store.data.completedCodexImports?.[transferId]
        : undefined;
      if (completed?.nativeId === nativeId)
        return { status: "moved", receipt: completed };
      if (completed)
        throw new Error("The transfer ID belongs to a different session");
      const existing = this.store.data.conversations.find(
        (chat) => chat.provider === "codex" && chat.nativeId === nativeId,
      );
      if (existing)
        return {
          status: "rejected",
          reason: "This Codex session already exists on the Linux host",
        };
      const pending = this.store.data.pendingCodexImports?.[nativeId];
      if (pending && pending.id !== transferId)
        return {
          status: "rejected",
          reason: "Another move already owns this Codex session",
        };
      let cwd: string;
      try {
        const workspace = this.store.workspace(workspaceId);
        if (!workspace.folders.includes(requestedCwd))
          throw new Error("Choose a folder attached to the Linux workspace");
        cwd = await realpath(requestedCwd);
        if (!(await stat(cwd)).isDirectory())
          throw new Error("The destination working directory is unavailable");
      } catch (error) {
        if (pending) throw error;
        return { status: "rejected", reason: reason(error) };
      }
      if (!transferId) return { status: "ready" };
      const rollout = request.rollout as CodexRollout | undefined;
      if (
        typeof rollout?.filename !== "string" ||
        typeof rollout.bytes !== "string"
      )
        throw new Error("The Linux host did not receive a saved Codex session");
      const digest = createHash("sha256")
        .update(rollout.filename)
        .update("\0")
        .update(rollout.bytes)
        .digest("hex");
      if (
        pending &&
        (pending.digest !== digest ||
          pending.workspace !== workspaceId ||
          pending.cwd !== requestedCwd)
      )
        throw new Error(
          "The retried transfer no longer matches its original session or destination",
        );
      await this.store.change(() => {
        (this.store.data.pendingCodexImports ??= {})[nativeId] = {
          id: transferId,
          digest,
          workspace: workspaceId,
          cwd: requestedCwd,
        };
      });
      const clearPending = () =>
        this.store.change(() => {
          delete this.store.data.pendingCodexImports![nativeId];
        });
      let installed: Awaited<ReturnType<typeof installCodexRollout>>;
      try {
        installed = await installCodexRollout(nativeId, rollout, transferId);
      } catch (error) {
        if (pending) throw error;
        await clearPending();
        return { status: "rejected", reason: reason(error) };
      }
      let receipt: TransferReceipt;
      try {
        receipt = await this.conversations.importSavedCodex({
          transferId,
          nativeId,
          workspaceId,
          cwd,
          requestedCwd,
          title:
            typeof request.title === "string"
              ? request.title.slice(0, 255)
              : undefined,
          draft:
            typeof request.draft === "string" &&
            Buffer.byteLength(JSON.stringify(request.draft)) <= 1024 * 1024
              ? request.draft
              : undefined,
          rolloutPath: installed.file,
        });
      } catch (error) {
        await installed.finish(true);
        await clearPending();
        return { status: "rejected", reason: reason(error) };
      }
      await installed.finish();
      return { status: "moved", receipt };
    } finally {
      this.receiving.delete(nativeId);
    }
  }
}
