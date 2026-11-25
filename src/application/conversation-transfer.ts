import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { conversationHandoffReason } from "../conversation-actions";
import type { ConversationState, OperationRequest } from "../types";
import {
  installCodexRollout,
  preflightCodexRollout,
  readCodexRollout,
} from "../providers/codex-rollout";
import {
  appendCodexChunk,
  beginCodexStage,
  codexStageDigest,
  readCodexStage,
  removeCodexStage,
} from "../providers/codex-rollout-staging";
import type { ConversationApplicationService } from "./conversation-service";
import type { WorkspaceApplicationService } from "./workspace-service";
import type { ApplicationStateStore } from "./state";
import { requiredString } from "./request";

export type TransferDestination = Omit<
  NonNullable<ConversationState["transfer"]>,
  "id" | "committing"
>;

interface TransferReceipt {
  id: string;
  paneId: string;
  nativeId: string;
}

type TransferReply =
  | { status: "ready"; chunkedTransfer?: true }
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
        if (!checked.chunkedTransfer)
          throw new Error(
            "Update the Linux workspace host before moving this chat",
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
        const transfer = existing ?? {
          id: randomUUID(),
          ...destination,
          committing: false,
        };
        chat.transfer = transfer;
        return { chat, transfer, draft: draft?.text };
      });
      const { chat, transfer } = prepared;
      const release = () =>
        this.store.change(() => {
          const current = this.store.conversation(id);
          if (current.transfer?.id === transfer.id) delete current.transfer;
        });
      const payload = {
        op: "conversation.accept-transfer",
        transferId: transfer.id,
        nativeId: chat.nativeId,
        workspace: transfer.workspace,
        cwd: transfer.cwd,
      };
      let staged: TransferReply | undefined;
      let committing = transfer.committing;
      try {
        await this.conversations.disposeController(id);
        if (committing) {
          const status = (await receive({ ...payload, phase: "status" })) as
            TransferReply | undefined;
          if (
            status?.status === "moved" &&
            status.receipt.nativeId === chat.nativeId
          ) {
            await this.workspaces.finishTransfer(id, transfer.id);
            return status.receipt;
          }
          if (status?.status !== "ready")
            throw new Error(
              status?.status === "rejected"
                ? status.reason
                : "The Linux host did not confirm the saved history transfer",
            );
        }
        const rollout = await readCodexRollout(chat.nativeId, chat.cwd);
        staged = (await receive({
          ...payload,
          phase: "stage",
          manifest: rollout.manifest,
        })) as TransferReply | undefined;
        if (staged?.status === "ready") {
          let offset = 0;
          for await (const chunk of rollout.read()) {
            const acknowledged = (await receive({
              ...payload,
              phase: "chunk",
              offset,
              bytes: chunk.toString("base64"),
            })) as TransferReply | undefined;
            if (acknowledged?.status !== "ready")
              throw new Error(
                "The Linux host did not acknowledge the saved history chunk",
              );
            offset += chunk.length;
          }
          await this.store.change(() => {
            const current = this.store.conversation(id).transfer;
            if (current?.id !== transfer.id)
              throw new Error(
                "The source chat changed while preparing the move",
              );
            current.committing = true;
          });
          committing = true;
        } else if (staged?.status !== "moved") {
          throw new Error(
            staged?.status === "rejected"
              ? staged.reason
              : "The Linux host did not prepare the saved history",
          );
        }
      } catch (error) {
        if (!committing) {
          await release();
          await receive({ ...payload, phase: "discard" }).catch(
            () => undefined,
          );
        }
        throw error;
      }
      const reply =
        staged.status === "moved"
          ? staged
          : ((await receive({
              ...payload,
              title: chat.displayName,
              draft: prepared.draft,
            })) as TransferReply | undefined);
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
    if (
      this.receiving.has(nativeId) ||
      (transferId && this.receiving.has(transferId))
    )
      throw new Error("The destination is still receiving this Codex session");
    this.receiving.add(nativeId);
    if (transferId) this.receiving.add(transferId);
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
      if (!transferId) return { status: "ready", chunkedTransfer: true };
      if (request.rollout !== undefined && !pending)
        return {
          status: "rejected",
          reason: "Update the desktop before moving this chat to Linux",
        };
      const binding = { nativeId, workspace: workspaceId, cwd: requestedCwd };
      if (request.phase === "status") return { status: "ready" };
      if (request.phase === "stage") {
        const protectedTransfers = new Set(
          Object.values(this.store.data.pendingCodexImports ?? {}).map(
            (item) => item.id,
          ),
        );
        await beginCodexStage(
          transferId,
          binding,
          request.manifest,
          protectedTransfers,
        );
        return { status: "ready" };
      }
      if (request.phase === "chunk") {
        await appendCodexChunk(
          transferId,
          binding,
          request.offset,
          request.bytes,
        );
        return { status: "ready" };
      }
      if (request.phase === "discard") {
        if (pending)
          throw new Error("This Codex move may already be committed");
        await removeCodexStage(transferId, binding);
        return { status: "ready" };
      }
      if (request.phase !== undefined)
        throw new Error("Invalid Codex transfer phase");
      const { file, manifest } = await readCodexStage(transferId, binding);
      const digest = codexStageDigest(manifest);
      const discard = () => removeCodexStage(transferId, binding);
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
        installed = await installCodexRollout(
          nativeId,
          manifest,
          file,
          transferId,
        );
      } catch (error) {
        if (pending) throw error;
        await clearPending();
        await discard().catch(() => undefined);
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
        await discard().catch(() => undefined);
        return { status: "rejected", reason: reason(error) };
      }
      await installed.finish();
      await discard().catch(() => undefined);
      return { status: "moved", receipt };
    } finally {
      this.receiving.delete(nativeId);
      if (transferId) this.receiving.delete(transferId);
    }
  }
}
