import {
  encodeQuestionAnswer,
  questionAnswers,
  questionHistory,
} from "../codex-questions";
import { normalizeGroups } from "../workspace-layout";
import {
  acknowledgeConversation,
  backgroundWithUnknownState,
  conversationHandoffReason,
  hasRunningBackground,
} from "../conversation-actions";
import { parseProviderCommand } from "../provider-commands";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { stat } from "node:fs/promises";
import { resolveProviderExecutable } from "../provider-executables";
import { defaultSocketPath } from "../paths";
import {
  DetachedProviderAdapter,
  LocalOwnerUnavailable,
  type LocalProviderOwner,
} from "../providers/local-owner-client";
import {
  createCodexAdapter,
  createKimiAdapter,
  type ProviderAdapter,
  type ProviderEvent,
} from "../providers";
import { codexItemsCursor } from "../conversation-history-cursor";
import {
  commitHistory,
  emptyHistory,
  stageCodexItemsPage,
  stageCodexSnapshot,
  stageKimiEvent,
  type StagedHistory,
} from "../conversation-history";
import type {
  ConversationMessage,
  ConversationState,
  QueuedMessage,
  WorkspaceState,
  TerminalState,
  OperationRequest,
} from "../types";
import { ApplicationStateStore } from "./state";
import type { DraftOptionChange, ProviderOptions } from "../providers/types";
import type { TerminalApplicationService } from "./terminal-service";
import { requiredString, providerId, object } from "./request";
export interface ConversationViewPort {
  show(id: string): Promise<unknown>;
  finishPage(
    request: OperationRequest,
    conversationId: string,
    status: "completed" | "uncertain",
  ): void;
}
export class ConversationApplicationService {
  private controllers = new Map<string, ProviderAdapter>();
  private controllerInitializations = new Map<
    string,
    Promise<ProviderAdapter>
  >();
  private generations = new Map<string, number>();
  private activeTurns = new Set<string>();
  private externalTurns = new Set<string>();
  private steering = new Set<string>();
  private pendingToolResults = new Map<string, number>();
  private drainingQueues = new Set<string>();
  private scheduleQueue(id: string): void {
    // Let native completion handlers release their active turn first.
    setTimeout(() => void this.drainQueue(id), 0);
  }
  private async drainQueue(id: string): Promise<void> {
    const conversation = this.store.data.conversations.find((c) => c.id === id);
    if (
      !conversation ||
      this.store.closing ||
      this.drainingQueues.has(id) ||
      this.isActive(id) ||
      conversation.queuePaused ||
      conversation.handoffTerminalId ||
      conversation.status !== "ready"
    )
      return;
    const message = conversation.queuedMessages?.[0];
    if (!message || message.status !== "queued" || message.editing) return;
    this.drainingQueues.add(id);
    try {
      const admitted = await this.store.change(() => {
        if (
          !this.isCurrent(conversation) ||
          this.isActive(id) ||
          conversation.status !== "ready" ||
          conversation.queuePaused ||
          conversation.queuedMessages?.[0] !== message ||
          message.status !== "queued" ||
          message.editing
        )
          return false;
        message.status = "sending";
        return true;
      });
      if (!admitted) return;
      await this.sendConversation(
        {
          op: "conversation.send",
          id,
          text: message.text,
          images: message.images,
          skills: message.skills,
          queuedMessageId: message.id,
        },
        true,
      );
    } catch (error) {
      if (this.isCurrent(conversation)) {
        const current = conversation.queuedMessages?.find(
          (m) => m.id === message.id,
        );
        if (current) current.status = "queued";
        conversation.queuePaused = true;
        conversation.error = `Message remains queued: ${error instanceof Error ? error.message : String(error)}`;
        this.store.notify();
        this.store.schedulePersist(true);
      }
    } finally {
      this.drainingQueues.delete(id);
    }
  }
  private finishQueued(
    conversation: ConversationState,
    request: OperationRequest,
    pause: boolean,
  ): void {
    const message = conversation.queuedMessages?.find(
      (m) => m.id === request.queuedMessageId,
    );
    if (message) {
      if (pause) message.status = "uncertain";
      else
        conversation.queuedMessages = conversation.queuedMessages!.filter(
          (m) => m !== message,
        );
    }
    if (pause) conversation.queuePaused = true;
    this.store.notify();
    this.scheduleQueue(conversation.id);
  }

  private turnClocks = new Map<
    string,
    { id: string; start: number; workingStart?: number; worked: number }
  >();
  private resumeContexts = new Map<string, StagedHistory>();
  private readonly replays = new Set<ProviderAdapter>();
  constructor(
    private readonly store: ApplicationStateStore,
    private readonly terminals: Pick<
      TerminalApplicationService,
      "createProcess" | "attachTerminal"
    >,
    private readonly views: ConversationViewPort,
    private readonly detached?: {
      owner: LocalProviderOwner;
      enabled: () => boolean;
    },
  ) {}
  selection(
    id: string,
  ): import("../providers/types").ProviderOptions["current"] {
    const conversation = this.store.conversation(id);
    const controller = this.controllers.get(conversation.id);
    if (!controller && conversation.initialSelection)
      return { ...conversation.initialSelection };
    if (!controller)
      throw new Error(
        "The source chat model is unavailable. Open the chat or use New chat with provider defaults.",
      );
    const selection = controller.getSelection();
    if (!selection.model)
      throw new Error(
        "The source chat model is unavailable. Use New chat with provider defaults.",
      );
    return selection;
  }
  private beginTurn(conversation: ConversationState): string {
    const id = randomUUID();
    (conversation.turns ??= []).push({
      id,
      startedAt: new Date().toISOString(),
    });
    this.turnClocks.set(conversation.id, {
      id,
      start: performance.now(),
      worked: 0,
    });
    return id;
  }
  private finishTurn(
    conversation: ConversationState,
    outcome: "completed" | "cancelled" | "failed" | undefined,
    at = Date.now(),
  ): void {
    const clock = this.turnClocks.get(conversation.id);
    const turn = conversation.turns?.find((turn) => turn.id === clock?.id);
    if (!turn || !clock || turn.finishedAt) return;
    const now = performance.now() - Math.max(0, Date.now() - at);
    turn.elapsedMs = Math.max(0, Math.round(now - clock.start));
    turn.durationMs = Math.max(
      0,
      Math.round(
        clock.worked +
          (clock.workingStart === undefined ? 0 : now - clock.workingStart),
      ),
    );
    if (outcome) {
      turn.finishedAt = new Date(at).toISOString();
      turn.outcome = outcome;
    }
  }
  private currentTurn(conversation: ConversationState): string | undefined {
    return this.activeTurns.has(conversation.id)
      ? this.turnClocks.get(conversation.id)?.id
      : undefined;
  }
  isActive(id: string): boolean {
    return this.activeTurns.has(id) || this.pendingToolResults.has(id);
  }
  reserve(id: string): void {
    if (this.isActive(id))
      throw new Error("A turn is already active for this conversation");
    this.activeTurns.add(id);
  }
  release(id: string): void {
    if (!this.externalTurns.has(id)) this.activeTurns.delete(id);
    this.scheduleQueue(id);
  }
  async ensureReady(conversation: ConversationState): Promise<void> {
    await this.ensureController(conversation);
    this.assertCurrent(conversation);
  }
  async sendReserved(
    conversation: ConversationState,
    text: string,
    messageId: string,
  ): Promise<void> {
    this.assertCurrent(conversation);
    if (this.store.closing) throw new Error("Cod is shutting down");
    const adapter = this.controllers.get(conversation.id);
    if (!adapter) throw new Error("Conversation controller unavailable");
    const turnId = this.beginTurn(conversation);
    conversation.messages.push({
      id: messageId,
      turnId,
      role: "user",
      text,
      order: this.nextOrder(conversation),
    });
    this.store.notify();
    try {
      const outcome = await adapter.send(text);
      if (this.store.closing) return;
      if (this.turnClocks.get(conversation.id)?.id === turnId)
        this.finishTurn(conversation, outcome.status);
    } catch (error) {
      if (
        !this.store.closing &&
        this.turnClocks.get(conversation.id)?.id === turnId
      )
        this.finishTurn(conversation, "failed");
      throw error;
    } finally {
      this.store.schedulePersist(true);
    }
  }
  async findFreshUserMessage(
    conversation: ConversationState,
    text: string,
  ): Promise<ConversationMessage | undefined> {
    const existing = this.controllers.get(conversation.id);
    const previousStatus = conversation.status;
    if (existing) {
      this.controllers.delete(conversation.id);
      await existing.dispose();
      delete conversation.detachedOwner;
      this.assertCurrent(conversation);
      conversation.status = previousStatus;
    }
    const history = emptyHistory();
    const replay = await this.adapterFor(conversation, (event) => {
      if (conversation.provider === "codex" && event.type === "history")
        stageCodexSnapshot(
          history,
          event.details,
          undefined,
          conversation.nativeId,
        );
      else if (conversation.provider === "kimi") stageKimiEvent(history, event);
    });
    this.replays.add(replay);
    try {
      this.assertCurrent(conversation);
      const native = await replay.resume(conversation.nativeId);
      const match = (message: ConversationMessage) =>
        message.role === "user" && message.text === text;
      let found = history.messages.find(match);
      let cursor = codexItemsCursor(native.metadata);
      // An older missing receipt remains uncertain. Search native pages without
      // storing an unbounded replay or relying on cached conversation history.
      for (
        let pageCount = 0;
        !found && cursor && replay.earlierHistory && pageCount < 20;
        pageCount++
      ) {
        const page = await replay.earlierHistory(cursor);
        const staged = emptyHistory();
        stageCodexItemsPage(staged, page.items, conversation.nativeId);
        found = staged.messages.find(match);
        if (cursor === page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return found;
    } finally {
      this.replays.delete(replay);
      await replay.dispose();
    }
  }
  quitStatus(): { active: number; canLeaveRunning: boolean } {
    const active = this.store.data.conversations.filter(
      (conversation) =>
        this.isActive(conversation.id) ||
        ["starting", "working", "waiting"].includes(conversation.status) ||
        hasRunningBackground(conversation),
    );
    return {
      active: active.length,
      canLeaveRunning:
        active.length > 0 &&
        active.every(
          (conversation) =>
            this.controllers.get(conversation.id) instanceof
            DetachedProviderAdapter,
        ),
    };
  }

  async shutdown(leaveRunning = false): Promise<void> {
    for (const id of this.activeTurns) {
      const conversation = this.store.data.conversations.find(
        (item) => item.id === id,
      );
      if (
        conversation &&
        !(
          leaveRunning &&
          this.controllers.get(id) instanceof DetachedProviderAdapter
        )
      ) {
        this.finishTurn(conversation, "cancelled");
        conversation.status = "failed";
        conversation.pendingPermissions = [];
        conversation.error =
          "Turn interrupted by app shutdown; send explicitly to resume.";
        this.addApplicationMessage(conversation, conversation.error);
      } else if (conversation) this.finishTurn(conversation, undefined);
    }
    this.activeTurns.clear();
    this.externalTurns.clear();
    const disposals = [...this.controllers.values(), ...this.replays].map(
      (adapter) => {
        if (adapter instanceof DetachedProviderAdapter) {
          adapter.detach();
          return;
        }
        return adapter.dispose();
      },
    );
    if (!leaveRunning) {
      for (const conversation of this.store.data.conversations)
        delete conversation.detachedOwner;
      disposals.push(this.detached?.owner.stop());
    }
    await Promise.all(disposals);
    this.controllers.clear();
  }
  private draftCwd(workspace: WorkspaceState, paneId: string): string {
    return path.resolve(
      workspace.chatDrafts?.[paneId]?.cwd ??
        workspace.folders[0] ??
        process.env.HOME ??
        process.cwd(),
    );
  }

  private async draftOptions(request: OperationRequest, selecting: boolean) {
    const workspaceId = requiredString(request, "workspace");
    const paneId = requiredString(request, "paneId");
    const target = () => {
      const workspace = this.store.workspace(workspaceId);
      const pane = this.store.pane(workspace, paneId);
      const draft = workspace.chatDrafts?.[paneId];
      if (
        pane.kind !== "document" ||
        !!pane.filePath ||
        (draft?.provider ?? "codex") !== "codex"
      )
        throw new Error("This pane no longer has an unsent Codex chat");
      return { workspace, draft, cwd: this.draftCwd(workspace, paneId) };
    };
    const original = target();
    const selection = { ...original.draft?.initialSelection };
    let change: DraftOptionChange | undefined;
    if (selecting) {
      if (request.option !== "model" && request.option !== "reasoning")
        throw new Error("Unknown provider option");
      change = {
        option: request.option,
        value:
          request.value === undefined
            ? undefined
            : requiredString(request, "value"),
      };
    }
    const resolved = await resolveProviderExecutable("codex");
    const adapter = createCodexAdapter({
      cwd: original.cwd,
      executable: resolved.executable,
      args: resolved.args,
    });
    this.replays.add(adapter);
    let options: ProviderOptions;
    try {
      options = await adapter.getDraftOptions(selection, change);
    } finally {
      this.replays.delete(adapter);
      await adapter.dispose();
    }

    const latest = () => {
      const current = target();
      if (
        original.workspace !== current.workspace ||
        original.cwd !== current.cwd ||
        selection.model !== current.draft?.initialSelection?.model ||
        selection.reasoning !== current.draft?.initialSelection?.reasoning
      )
        throw new Error("This draft setup changed. Open model choices again.");
      return current;
    };
    if (!change) {
      latest();
      return options;
    }
    return this.store.change(() => {
      const { workspace, draft } = latest();
      const updated = {
        text: "",
        ...draft,
        provider: "codex" as const,
        initialSelection: options.pending,
      };
      (workspace.chatDrafts ??= {})[paneId] = updated;
      return options;
    });
  }

  async createConversation(
    request: OperationRequest,
    resume: boolean,
  ): Promise<{ id: string; paneId: string; nativeId: string }> {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const provider = providerId(request);
    const cwd =
      typeof request.cwd === "string"
        ? path.resolve(request.cwd)
        : this.draftCwd(
            workspace,
            typeof request.paneId === "string"
              ? request.paneId
              : workspace.activePaneId,
          );
    const nativeId = resume ? requiredString(request, "nativeId") : "";
    const verifyOwnership = () => {
      if (provider !== "codex" || !nativeId) return;
      if (this.store.data.transferredCodexSessions?.includes(nativeId))
        throw new Error("This saved Codex session was moved to Linux");
      if (this.store.data.pendingCodexImports?.[nativeId])
        throw new Error("This Codex session is being moved into a workspace");
    };
    verifyOwnership();
    const attached = () =>
      resume
        ? this.store.data.conversations.find(
            (item) => item.provider === provider && item.nativeId === nativeId,
          )
        : undefined;
    let existing = attached();
    if (!existing) {
      if (!(await stat(cwd)).isDirectory())
        throw new Error("Working directory is not a directory");
      if (!this.store.data.workspaces.includes(workspace))
        throw new Error("Workspace was closed");
      // Another request may have attached it while this directory was checked.
      verifyOwnership();
      existing = attached();
    }
    if (existing) {
      await this.views.show(existing.id);
      return {
        id: existing.id,
        paneId: existing.paneId,
        nativeId: existing.nativeId,
      };
    }
    if (typeof request.paneId === "string") {
      const target = this.store.pane(workspace, request.paneId);
      if (target.kind !== "document" || target.filePath)
        throw new Error("Target must be an empty chat");
      workspace.activePaneId = target.id;
    }
    const previousPane = this.store.pane(workspace, workspace.activePaneId);
    const restoreDraft =
      previousPane.kind === "document" && !previousPane.filePath
        ? structuredClone(previousPane)
        : undefined;
    const previousConversationId = workspace.lastConversationId;
    const id = randomUUID();
    const conversation: ConversationState = {
      id,
      paneId: "",
      workspaceId: workspace.id,
      provider,
      nativeId,
      cwd,
      status: "starting",
      messages: [],
      tools: [],
      pendingPermissions: [],
      ...(!resume &&
      restoreDraft &&
      workspace.chatDrafts?.[restoreDraft.id]?.provider === provider
        ? {
            initialSelection:
              workspace.chatDrafts[restoreDraft.id].initialSelection,
          }
        : {}),
    };
    this.generations.set(id, 0);
    this.store.data.conversations.push(conversation);
    conversation.paneId = this.attachConversation(workspace, id);
    workspace.lastConversationId = id;
    this.store.notify();
    let adapter: ProviderAdapter | undefined;
    try {
      adapter = await this.adapterFor(conversation);
      this.assertCurrent(conversation);
      this.controllers.set(id, adapter);
      const staged = emptyHistory();
      if (resume) this.resumeContexts.set(id, staged);
      const native = resume
        ? await adapter.resume(nativeId)
        : await adapter.create();
      this.assertCurrent(conversation);
      if (resume) {
        const metadata = object(native.metadata);
        if (metadata.turnsBackwardsCursor || metadata.itemsBackwardsCursor)
          staged.partial = true;
        commitHistory(conversation, staged);
      }
      conversation.nativeId = native.nativeId;
      conversation.metadata = native.metadata;
      conversation.status = "ready";
      await this.store.serialize(() => this.store.persist());
      this.store.notify();
      return {
        id,
        paneId: conversation.paneId,
        nativeId: conversation.nativeId,
      };
    } catch (error) {
      try {
        await this.store.serialize(() =>
          this.removeConversationRecord(
            conversation,
            restoreDraft,
            previousConversationId,
          ),
        );
      } finally {
        await this.disposeController(id);
        await adapter?.dispose();
        this.store.notify();
        this.store.schedulePersist(true);
      }
      throw error;
    } finally {
      this.resumeContexts.delete(id);
    }
  }

  async importSavedCodex(input: {
    transferId: string;
    workspaceId: string;
    nativeId: string;
    cwd: string;
    requestedCwd: string;
    rolloutPath: string;
    title?: string;
    draft?: string;
  }): Promise<{ id: string; paneId: string; nativeId: string }> {
    const conversation: ConversationState = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      nativeId: input.nativeId,
      cwd: input.cwd,
      displayName: input.title,
      provider: "codex",
      paneId: "",
      status: "ready",
      messages: [],
      tools: [],
      pendingPermissions: [],
    };
    const history = emptyHistory();
    const reader = await this.adapterFor(conversation, (event) => {
      if (event.type === "history")
        stageCodexSnapshot(history, event.details, undefined, input.nativeId);
    });
    this.replays.add(reader);
    try {
      const native = await reader.resume(input.nativeId);
      const metadata = object(native.metadata);
      if (metadata.cwd !== input.cwd)
        throw new Error("Codex did not resume in the selected Linux directory");
      if (object(metadata.thread).path !== input.rolloutPath)
        throw new Error(
          "The destination Codex session already has a different saved file",
        );
      if (metadata.turnsBackwardsCursor || metadata.itemsBackwardsCursor)
        history.partial = true;
      commitHistory(conversation, history);
      conversation.metadata = native.metadata;
    } finally {
      this.replays.delete(reader);
      await reader.dispose();
    }
    return this.store.change(() => {
      if (this.store.closing)
        throw new Error("The Linux workspace host is shutting down");
      const workspace = this.store.workspace(input.workspaceId);
      if (!workspace.folders.includes(input.requestedCwd))
        throw new Error("The destination folder is no longer attached");
      if (
        this.store.data.pendingCodexImports?.[input.nativeId]?.id !==
          input.transferId ||
        this.store.data.conversations.some(
          (item) =>
            item.provider === "codex" && item.nativeId === input.nativeId,
        )
      )
        throw new Error("Another move already owns this Codex session");
      conversation.paneId = this.attachConversation(
        workspace,
        conversation.id,
        false,
      );
      workspace.lastConversationId = conversation.id;
      if (input.draft)
        (workspace.chatDrafts ??= {})[conversation.paneId] = {
          text: input.draft,
        };
      this.store.data.conversations.push(conversation);
      const receipt = {
        id: conversation.id,
        paneId: conversation.paneId,
        nativeId: input.nativeId,
      };
      (this.store.data.completedCodexImports ??= {})[input.transferId] =
        receipt;
      delete this.store.data.pendingCodexImports![input.nativeId];
      return receipt;
    });
  }

  private async removeConversationRecord(
    conversation: ConversationState,
    restoreDraft?: import("../types").DocumentPane,
    previousConversationId?: string,
  ): Promise<void> {
    const open = this.store.data.workspaces.find(
      (item) => item.id === conversation.workspaceId,
    );
    const archive = open
      ? undefined
      : await this.store.archivedWorkspace(conversation.workspaceId);
    this.store.data.conversations = this.store.data.conversations.filter(
      (item) => item.id !== conversation.id,
    );
    if (archive) {
      archive.conversations = archive.conversations.filter(
        (item) => item.id !== conversation.id,
      );
      this.store.data.closedWorkspaces = this.store.data.closedWorkspaces?.map(
        (item) =>
          item.workspace.id === conversation.workspaceId ? archive : item,
      );
    }
    const workspace = open ?? archive?.workspace;
    if (!workspace || !conversation.paneId) return;
    if (workspace.lastConversationId === conversation.id)
      workspace.lastConversationId = previousConversationId;
    workspace.panes = workspace.panes.filter(
      (pane) => pane.id !== conversation.paneId,
    );
    if (restoreDraft) {
      workspace.panes.push({ ...restoreDraft, draftChat: true });
      if (workspace.activePaneId === conversation.paneId)
        workspace.activePaneId = restoreDraft.id;
      return;
    }
    if (!workspace.panes.length) {
      const paneId = randomUUID();
      workspace.panes.push({ id: paneId, kind: "document", draftChat: true });
    }
    normalizeGroups(workspace);
  }

  attachConversation(
    workspace: WorkspaceState,
    conversationId: string,
    reuseDraft = true,
  ): string {
    const active = this.store.pane(workspace, workspace.activePaneId);
    if (reuseDraft && active.kind === "document" && !active.filePath) {
      const index = workspace.panes.indexOf(active);
      workspace.panes[index] = {
        id: active.id,
        pinned: active.pinned,
        kind: "conversation",
        conversationId,
      };
      workspace.activePaneId = active.id;
      return active.id;
    }
    const paneId = randomUUID();
    workspace.panes.push({ id: paneId, kind: "conversation", conversationId });
    workspace.activePaneId = paneId;
    return paneId;
  }

  async adapterFor(
    conversation: ConversationState,
    onEvent?: (event: ProviderEvent) => void,
  ): Promise<ProviderAdapter> {
    const resolved = await resolveProviderExecutable(conversation.provider);
    if (this.store.closing) throw new Error("Cod is shutting down");
    if (!onEvent) {
      if (conversation.detachedOwner)
        throw new Error(
          "Quit Cod to stop the disconnected owner before resuming this chat",
        );
      if (this.detached?.enabled()) {
        const adapter = await this.detached.owner.open(
          {
            id: conversation.id,
            workspace: conversation.workspaceId,
            provider: conversation.provider,
            cwd: conversation.cwd,
            executable: resolved.executable,
            args: resolved.args,
            commandSocket: defaultSocketPath(),
          },
          (event, cursor, at) => {
            if (this.store.closing) return;
            conversation.detachedOwner = cursor;
            this.providerEvent(conversation.id, event, at);
          },
        );
        conversation.detachedOwner = { ...adapter.cursor };
        return adapter;
      }
    }
    const options = {
      cwd: conversation.cwd,
      executable: resolved.executable,
      args: resolved.args,
      env: {
        ...process.env,
        COD_CONVERSATION_ID: conversation.id,
        COD_WORKSPACE_ID: conversation.workspaceId,
        COD_SOCKET_PATH: defaultSocketPath(),
        COD_DATA_DIR: this.store.directory,
        COD_CLI_PATH: path.join(__dirname, "cli.cjs"),
        COD_NODE_PATH: process.execPath,
      },
      onEvent:
        onEvent ??
        ((event: ProviderEvent) => this.providerEvent(conversation.id, event)),
    };
    return conversation.provider === "codex"
      ? createCodexAdapter(options)
      : createKimiAdapter(options);
  }

  async handoffConversation(
    id: string,
  ): Promise<{ id: string; paneId: string; terminalId: string }> {
    const terminalId = randomUUID();
    const { conversation, workspace } = await this.store.serialize(() => {
      const conversation = this.store.conversation(id);
      if (
        conversation.provider === "codex" &&
        this.store.data.transferredCodexSessions?.includes(
          conversation.nativeId,
        )
      )
        throw new Error("This saved Codex session was moved to Linux");
      const reason = conversationHandoffReason(this.store.data, conversation);
      if (reason) throw new Error(reason);
      if (this.isActive(id) || this.controllerInitializations.has(id))
        throw new Error(
          "Finish or interrupt the active turn before continuing in CLI",
        );
      const workspace = this.store.workspace(conversation.workspaceId);
      conversation.handoffTerminalId = terminalId;
      return { conversation, workspace };
    });
    try {
      const resolved = await resolveProviderExecutable(conversation.provider);
      await this.disposeController(id);
      this.assertCurrent(conversation);
      const snapshot = this.terminals.createProcess({
        id: terminalId,
        workspaceId: workspace.id,
        cwd: conversation.cwd,
        cols: 100,
        rows: 30,
        shell: resolved.executable,
        env: {
          ...process.env,
          COD_CONVERSATION_ID: id,
          COD_WORKSPACE_ID: workspace.id,
          COD_SOCKET_PATH: defaultSocketPath(),
          COD_DATA_DIR: this.store.directory,
          COD_CLI_PATH: path.join(__dirname, "cli.cjs"),
          COD_NODE_PATH: process.execPath,
        },
        args: [
          ...(resolved.args ?? []),
          ...(conversation.provider === "codex"
            ? ["resume", conversation.nativeId]
            : ["--session", conversation.nativeId]),
        ],
      });
      const terminal: TerminalState = {
        ...snapshot,
        paneId: "",
        sequence: 0,
        nativeConversationId: id,
      };
      terminal.paneId = this.terminals.attachTerminal(workspace, terminalId);
      this.store.data.terminals.push(terminal);
      conversation.handoffTerminalId = terminalId;
      conversation.status = "closed";
      conversation.pendingPermissions = [];
      await this.store.serialize(() => this.store.persist());
      this.store.notify();
      return { id, paneId: terminal.paneId, terminalId };
    } catch (error) {
      if (
        !this.store.data.terminals.some(
          (terminal) => terminal.id === terminalId,
        )
      )
        conversation.handoffTerminalId = undefined;
      throw error;
    }
  }

  async reclaimConversation(
    id: string,
  ): Promise<{ id: string; paneId: string }> {
    const conversation = this.store.conversation(id);
    if (!conversation.handoffTerminalId)
      throw new Error("Conversation is not handed off");
    const terminal = this.store.data.terminals.find(
      (item) => item.id === conversation.handoffTerminalId,
    );
    if (terminal && ["running", "starting"].includes(terminal.status))
      throw new Error(
        "Exit the native CLI or close its terminal before returning to chat",
      );
    const previous = conversation.handoffTerminalId;
    conversation.handoffTerminalId = undefined;
    try {
      await this.ensureController(conversation);
    } catch (error) {
      conversation.handoffTerminalId = previous;
      throw error;
    }
    await this.views.show(id);
    return { id, paneId: conversation.paneId };
  }

  ensureController(conversation: ConversationState): Promise<ProviderAdapter> {
    if (
      conversation.provider === "codex" &&
      this.store.data.transferredCodexSessions?.includes(conversation.nativeId)
    )
      return Promise.reject(
        new Error("This saved Codex session was moved to Linux"),
      );
    if (conversation.transfer)
      return Promise.reject(
        new Error("Resolve the pending move to Linux first"),
      );
    const pending = this.controllerInitializations.get(conversation.id);
    if (pending) return pending;
    const loading = this.loadController(conversation).then(async (adapter) => {
      const selection = conversation.initialSelection;
      if (selection) {
        for (const option of ["model", "reasoning"] as const) {
          const value = selection[option];
          if (value && adapter.getSelection()[option] !== value)
            await adapter.setOption({ option, value });
          this.assertCurrent(conversation);
        }
      }
      return adapter;
    });
    this.controllerInitializations.set(conversation.id, loading);
    void loading
      .finally(() => {
        if (this.controllerInitializations.get(conversation.id) === loading)
          this.controllerInitializations.delete(conversation.id);
      })
      .catch(() => undefined);
    return loading;
  }

  private async earlierHistory(id: string): Promise<{ added: number }> {
    const conversation = this.store.conversation(id);
    if (conversation.provider !== "codex" || !conversation.historyPartial)
      return { added: 0 };
    const adapter = await this.ensureController(conversation);
    this.assertCurrent(conversation);
    if (!conversation.historyPartial) return { added: 0 };
    const cursor = codexItemsCursor(conversation.metadata);
    if (!cursor || !adapter.earlierHistory)
      throw new Error("Codex does not provide an earlier item cursor");
    const { items, nextCursor } = await adapter.earlierHistory(cursor);
    const staged = emptyHistory();
    stageCodexItemsPage(staged, items, conversation.nativeId);
    return this.store.change(() => {
      this.assertCurrent(conversation);
      // Resume, a moved cursor or controller replacement supersedes this page.
      if (
        this.controllers.get(id) !== adapter ||
        codexItemsCursor(conversation.metadata) !== cursor
      )
        return { added: 0 };
      const before = conversation.messages.length + conversation.tools.length;
      commitHistory(conversation, staged, true);
      conversation.historyPartial = Boolean(nextCursor);
      conversation.metadata = {
        ...object(conversation.metadata),
        itemsBackwardsCursor: nextCursor ?? null,
      };
      return {
        added:
          conversation.messages.length + conversation.tools.length - before,
      };
    });
  }

  private async historyOutput(id: string, toolId: string): Promise<void> {
    const conversation = this.store.conversation(id);
    const adapter = await this.ensureController(conversation);
    this.assertCurrent(conversation);
    const tool = conversation.tools.find((item) => item.id === toolId);
    if (!tool || !object(tool.details).outputDeferred) return;
    const prefix = `codex/${conversation.nativeId}/`;
    if (!toolId.startsWith(prefix) || !adapter.historyOutput)
      throw new Error("Codex does not provide the selected history output");
    const [turnId, itemId] = toolId.slice(prefix.length).split("/");
    if (!turnId || !itemId)
      throw new Error("Codex does not provide the selected history output");
    const details = await adapter.historyOutput(turnId, itemId);
    await this.store.change(() => {
      this.assertCurrent(conversation);
      const current = conversation.tools.find((item) => item.id === toolId);
      if (
        this.controllers.get(id) === adapter &&
        current &&
        object(current.details).outputDeferred
      )
        current.details = details;
    });
  }

  async loadController(
    conversation: ConversationState,
  ): Promise<ProviderAdapter> {
    if (conversation.handoffTerminalId)
      throw new Error(
        "Native CLI owns this session; return to chat explicitly after it exits",
      );
    this.assertCurrent(conversation);
    const existing = this.controllers.get(conversation.id);
    if (existing instanceof DetachedProviderAdapter && existing.watchError) {
      // A replay failure cannot tell us whether the owner is still running.
      // A verified unavailable owner can be retired locally without release.
      if (!(existing.watchError instanceof LocalOwnerUnavailable))
        throw existing.watchError;
      this.controllers.delete(conversation.id);
      existing.detach();
      delete conversation.detachedOwner;
    } else if (existing) {
      if (conversation.status !== "failed") return existing;
      this.controllers.delete(conversation.id);
      await existing.dispose();
      delete conversation.detachedOwner;
      this.assertCurrent(conversation);
    }
    const adapter = await this.adapterFor(conversation);
    this.assertCurrent(conversation);
    this.controllers.set(conversation.id, adapter);
    const staged = emptyHistory();
    this.resumeContexts.set(conversation.id, staged);
    try {
      const native = await adapter.resume(conversation.nativeId);
      this.assertCurrent(conversation);
      const metadata = object(native.metadata);
      if (metadata.turnsBackwardsCursor || metadata.itemsBackwardsCursor)
        staged.partial = true;
      commitHistory(conversation, staged);
      conversation.metadata = native.metadata;
      conversation.status = "ready";
      conversation.error = undefined;
      this.store.notify();
      this.store.schedulePersist(true);
      return adapter;
    } catch (error) {
      if (this.controllers.get(conversation.id) === adapter) {
        this.controllers.delete(conversation.id);
      }
      if (this.isCurrent(conversation)) {
        conversation.status = "failed";
        conversation.error =
          error instanceof Error ? error.message : String(error);
        this.addApplicationMessage(
          conversation,
          `Resume failed: ${conversation.error}`,
        );
        this.store.notify();
        this.store.schedulePersist(true);
      }
      await adapter.dispose();
      delete conversation.detachedOwner;
      throw error;
    } finally {
      this.resumeContexts.delete(conversation.id);
    }
  }

  validateImages(
    value: unknown,
  ): import("../providers/types").ImageAttachment[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 8)
      throw new Error("At most 8 images may be attached");
    let bytes = 0;
    const references = new Set<number>();
    return value.map((item, index) => {
      const image = object(item);
      if (
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          String(image.mimeType),
        ) ||
        typeof image.data !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
      )
        throw new Error("Invalid image attachment");
      const reference = image.reference ?? index + 1;
      if (
        !Number.isSafeInteger(reference) ||
        Number(reference) <= 0 ||
        references.has(Number(reference))
      )
        throw new Error("Image references must be distinct positive integers");
      references.add(Number(reference));
      bytes += Buffer.byteLength(image.data, "base64");
      if (bytes > 20 * 1024 * 1024) throw new Error("Attachments exceed 20 MB");
      return {
        mimeType:
          image.mimeType as import("../providers/types").ImageAttachment["mimeType"],
        data: image.data,
        ...(Number.isSafeInteger(image.reference) && Number(image.reference) > 0
          ? { reference: Number(image.reference) }
          : {}),
        ...(typeof image.name === "string"
          ? { name: image.name.slice(0, 255) }
          : {}),
      };
    });
  }

  private validateSkills(
    value: unknown,
  ): Array<{ name: string; path: string }> {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 32)
      throw new Error("skills must be an array of at most 32 references");
    return value.map((entry: unknown) => {
      if (!entry || typeof entry !== "object")
        throw new Error("Invalid skill reference");
      const skill = entry as Record<string, unknown>;
      if (
        typeof skill.name !== "string" ||
        !skill.name ||
        skill.name.length > 256 ||
        typeof skill.path !== "string" ||
        !skill.path ||
        skill.path.length > 8192
      )
        throw new Error("A skill reference requires its native name and path");
      return { name: skill.name, path: skill.path };
    });
  }

  private clearSubmittedDraft(
    conversation: ConversationState,
    text: string,
    images: import("../providers/types").ImageAttachment[],
    writer?: string,
  ): void {
    const workspace = this.store.workspace(conversation.workspaceId);
    const draft = workspace.chatDrafts?.[conversation.paneId];
    const attachments = draft?.images ?? [];
    if (
      !draft?.localDraft &&
      draft?.text === text &&
      attachments.length === images.length &&
      attachments.every(
        (image, i) =>
          image.data === images[i].data &&
          image.mimeType === images[i].mimeType &&
          image.reference === images[i].reference,
      )
    ) {
      // Keep one empty version transition so this writer can rebase an autosave
      // that was already in flight when its submitted message was cleared.
      workspace.chatDrafts![conversation.paneId] = {
        text: "",
        version: randomUUID(),
        writer:
          typeof writer === "string" && writer.length <= 64
            ? writer
            : draft.writer,
        clearedFromVersion: draft.version ?? "",
      };
    }
  }

  async sendConversation(
    request: OperationRequest,
    fromQueue = false,
    trustedUi = false,
    questionId?: string,
  ): Promise<{ id: string; status: string; messageId?: string }> {
    const conversation = this.store.conversation(requiredString(request, "id"));
    if (conversation.transfer)
      throw new Error("Resolve the pending move to Linux first");
    const text = typeof request.text === "string" ? request.text : "";
    if (parseProviderCommand(text))
      throw new Error(
        "Session commands are not prompts. Use conversation.native-inspect with a section, or open the desktop command menu.",
      );
    if (text.length > 1_000_000) throw new Error("Message is too long");
    const images = this.validateImages(request.images);
    const skills = this.validateSkills(request.skills);
    if (!text.trim() && !images.length)
      throw new Error("Message must not be blank");
    if (conversation.handoffTerminalId)
      throw new Error("Return to chat before sending a message");
    if (!fromQueue && request.pageId && this.isActive(conversation.id))
      throw new Error("Origin conversation is busy");
    if (
      trustedUi &&
      !fromQueue &&
      !request.pageId &&
      conversation.provider === "codex"
    ) {
      if (
        conversation.queuedMessages?.some(
          (item) =>
            item.steering &&
            item.text === text &&
            (item.images ?? []).length === images.length &&
            (item.images ?? []).every(
              (image, index) =>
                image.data === images[index]?.data &&
                image.mimeType === images[index]?.mimeType &&
                image.reference === images[index]?.reference,
            ),
        )
      )
        throw new Error("Check the pending follow-up before sending it again");
      const adapter = this.controllers.get(conversation.id);
      const nativeTurnId = adapter?.activeTurnIdentity();
      const localTurnId = this.currentTurn(conversation);
      if (
        request.expectedTurn !== undefined &&
        request.expectedTurn !== localTurnId
      )
        throw new Error(
          "The selected turn has ended. Your message was not sent.",
        );
      if (localTurnId && adapter && nativeTurnId) {
        const steered = await this.steerConversation(
          conversation,
          adapter,
          localTurnId,
          nativeTurnId,
          { id: randomUUID(), text, images, skills, status: "sending" },
          request.writer as string | undefined,
          questionId,
        );
        if (steered) return steered;
      }
    }
    if (
      !fromQueue &&
      (this.isActive(conversation.id) || conversation.queuedMessages?.length)
    ) {
      if (request.requireIdle === true)
        throw new Error(
          "Wait for the active or queued Codex work before sending",
        );
      const messageId = randomUUID();
      await this.store.change(() => {
        if (this.store.closing) throw new Error("Cod is shutting down");
        this.assertCurrent(conversation);
        if ((conversation.queuedMessages?.length ?? 0) >= 100)
          throw new Error("Message queue is full");
        (conversation.queuedMessages ??= []).push({
          id: messageId,
          text,
          ...(images.length ? { images } : {}),
          ...(skills.length ? { skills } : {}),
          status: "queued",
        });
        this.clearSubmittedDraft(
          conversation,
          text,
          images,
          request.writer as string | undefined,
        );
      });
      this.scheduleQueue(conversation.id);
      return { id: conversation.id, status: "queued", messageId };
    }
    if (this.activeTurns.has(conversation.id))
      throw new Error("Conversation is busy");
    if (!fromQueue) conversation.queuePaused = false;
    this.activeTurns.add(conversation.id);
    try {
      // Sending is a barrier after pending coalesced composer writes.
      if (!fromQueue) await this.store.serialize(() => undefined);
      const adapter = await this.ensureController(conversation);
      await adapter.resolveSkills(text, skills);
      this.assertCurrent(conversation);
      if (this.externalTurns.has(conversation.id))
        throw new Error("A turn is already active for this conversation");
      const turnId = this.beginTurn(conversation);
      delete conversation.initialSelection;
      conversation.messages.push({
        id: randomUUID(),
        turnId,
        role: "user",
        text,
        ...(images.length ? { images } : {}),
        order: this.nextOrder(conversation),
      });
      conversation.error = undefined;
      conversation.acknowledgedCompletionRevision =
        conversation.completionRevision ?? 0;
      if (!fromQueue && !questionId)
        this.clearSubmittedDraft(
          conversation,
          text,
          images,
          request.writer as string | undefined,
        );
      this.store.notify();
      this.store.schedulePersist();
      const turn = adapter.send(text, images, skills);
      const finishPage = (status: "completed" | "uncertain") =>
        this.views.finishPage(request, conversation.id, status);
      void turn.then(
        (outcome) => {
          if (this.store.closing) return;
          if (this.turnClocks.get(conversation.id)?.id === turnId) {
            this.finishTurn(conversation, outcome.status);
            this.activeTurns.delete(conversation.id);
          }
          finishPage("completed");
          if (questionId && outcome.status === "completed")
            this.releaseQuestionAnswer(conversation, questionId);
          if (outcome.status === "cancelled") conversation.queuePaused = true;
          this.finishQueued(
            conversation,
            fromQueue ? request : { op: "" },
            false,
          );
          this.store.schedulePersist(true);
        },
        (error) => {
          if (this.store.closing) return;
          finishPage("uncertain");
          if (this.turnClocks.get(conversation.id)?.id !== turnId) return;
          this.finishTurn(conversation, "failed");
          this.activeTurns.delete(conversation.id);
          this.finishQueued(
            conversation,
            fromQueue ? request : { op: "" },
            true,
          );
          conversation.status = "failed";
          conversation.error =
            error instanceof Error ? error.message : String(error);
          if (
            !conversation.messages.some(
              (message) =>
                message.origin === "application" &&
                message.text === `Provider failed: ${conversation.error}`,
            )
          ) {
            this.addApplicationMessage(
              conversation,
              `Provider failed: ${conversation.error}`,
            );
          }
          this.store.notify();
          this.store.schedulePersist(true);
        },
      );
      return { id: conversation.id, status: conversation.status };
    } catch (error) {
      this.release(conversation.id);
      throw error;
    }
  }

  private clearSteeredDraft(
    conversation: ConversationState,
    message: QueuedMessage,
    writer?: string,
  ): void {
    const version = message.steering?.draftVersion;
    if (
      !version ||
      this.store.workspace(conversation.workspaceId).chatDrafts?.[
        conversation.paneId
      ]?.version !== version
    )
      return;
    this.clearSubmittedDraft(
      conversation,
      message.text,
      message.images ?? [],
      writer,
    );
  }

  private async steerConversation(
    conversation: ConversationState,
    adapter: ProviderAdapter,
    localTurnId: string,
    nativeTurnId: string,
    message: QueuedMessage,
    writer?: string,
    questionId?: string,
  ) {
    const isTargetActive = () =>
      this.currentTurn(conversation) === localTurnId &&
      this.controllers.get(conversation.id) === adapter &&
      adapter.activeTurnIdentity() === nativeTurnId;
    if (this.steering.has(conversation.id))
      throw new Error("A follow-up is being prepared for the current turn");

    this.steering.add(conversation.id);
    try {
      await this.store.change(() => {
        this.assertCurrent(conversation);
        if (this.store.closing || !isTargetActive())
          throw new Error(
            "The selected turn has ended. Your message was not sent.",
          );
        const queue = (conversation.queuedMessages ??= []);
        if (queue.length >= 100) throw new Error("Message queue is full");
        message.steering = {
          nativeTurnId,
          localTurnId,
          draftVersion: questionId
            ? undefined
            : this.store.workspace(conversation.workspaceId).chatDrafts?.[
                conversation.paneId
              ]?.version,
        };
        queue.push(message);
      });
      let status;
      try {
        if (!isTargetActive())
          throw new Error(
            "The selected turn has ended. Your message was not sent.",
          );
        status = await adapter.steer(message, nativeTurnId, message.id);
      } finally {
        if (!status || status === "unsupported")
          await this.store.change(() => {
            this.assertCurrent(conversation);
            conversation.queuedMessages = conversation.queuedMessages!.filter(
              (item) => item.id !== message.id,
            );
          });
      }
      if (status === "unsupported") {
        // Method Not Found proves that native input was never admitted.
        if (this.currentTurn(conversation) !== localTurnId)
          throw new Error(
            "The selected turn has ended. Your message was not sent.",
          );
        return;
      }
      await this.store.change(() => {
        this.assertCurrent(conversation);
        const current = conversation.queuedMessages?.find(
          (item) => item.id === message.id,
        );
        if (current && (status === "uncertain" || !isTargetActive()))
          current.status = "uncertain";
        this.clearSteeredDraft(conversation, message, writer);
      });
      return { id: conversation.id, status, messageId: message.id };
    } finally {
      this.steering.delete(conversation.id);
      this.scheduleQueue(conversation.id);
    }
  }

  private recordSteeredItem(
    conversation: ConversationState,
    message: QueuedMessage,
    itemId: string,
  ): void {
    const steering = message.steering!;
    const id = `codex/${conversation.nativeId}/${steering.nativeTurnId}/${itemId}`;
    const existing = conversation.messages.find((item) => item.id === id);
    if (existing) {
      existing.text = message.text;
      existing.images = message.images;
    } else {
      conversation.messages.push({
        id,
        turnId: steering.localTurnId,
        role: "user",
        order: this.nextOrder(conversation),
        text: message.text,
        ...(message.images?.length ? { images: message.images } : {}),
      });
    }
    conversation.queuedMessages = conversation.queuedMessages!.filter(
      (item) => item.id !== message.id,
    );
    this.confirmQuestionAnswers(conversation, message.text);
  }

  private releaseQuestionAnswer(conversation: ConversationState, id: string) {
    const remaining = conversation.reservedQuestionAnswers?.filter(
      (item) => item !== id,
    );
    if (remaining?.length) conversation.reservedQuestionAnswers = remaining;
    else delete conversation.reservedQuestionAnswers;
  }

  private confirmQuestionAnswers(
    conversation: ConversationState,
    text: string,
  ) {
    if (!conversation.reservedQuestionAnswers?.length) return;
    for (const { questionItemId } of questionAnswers(text))
      this.releaseQuestionAnswer(conversation, questionItemId);
  }

  private async answerQuestion(request: OperationRequest) {
    const conversation = this.store.conversation(requiredString(request, "id"));
    const id = requiredString(request, "questionId");
    const answer = requiredString(request, "answer").trim();
    if (!answer || answer.length > 16_384)
      throw new Error("Enter an answer of at most 16,384 characters");
    if (
      conversation.provider !== "codex" ||
      conversation.handoffTerminalId ||
      conversation.transfer
    )
      throw new Error("Answer from a connected Codex chat");
    await this.ensureController(conversation);
    const { text, expectedTurn } = await this.store.change(() => {
      this.assertCurrent(conversation);
      if (this.store.closing) throw new Error("Cod is shutting down");
      if (conversation.handoffTerminalId || conversation.transfer)
        throw new Error("Answer from a connected Codex chat");
      const history = questionHistory(conversation);
      for (const replied of history.acknowledged.keys())
        this.releaseQuestionAnswer(conversation, replied);
      const question = conversation.messages
        .filter((message) => message.order > history.latestPrompt)
        .flatMap((message) => message.questions ?? [])
        .find((question) => question.id === id);
      if (!question) throw new Error("This question is no longer pending");
      if (
        conversation.reservedQuestionAnswers?.includes(id) ||
        history.wasAnswered(question)
      )
        throw new Error(
          "An answer was already submitted. Check the conversation before answering again.",
        );
      if ((conversation.reservedQuestionAnswers?.length ?? 0) >= 100)
        throw new Error("Too many unconfirmed answers");
      (conversation.reservedQuestionAnswers ??= []).push(id);
      return {
        text: encodeQuestionAnswer(question, answer),
        expectedTurn: this.currentTurn(conversation),
      };
    });
    try {
      if (expectedTurn !== this.currentTurn(conversation))
        throw new Error(
          "The selected turn has changed. Your answer was not sent.",
        );
      return await this.sendConversation(
        {
          op: "conversation.send",
          id: conversation.id,
          text,
          expectedTurn,
          requireIdle: true,
        },
        false,
        true,
        id,
      );
    } catch (error) {
      await this.store.change(() => {
        this.assertCurrent(conversation);
        const hasAdmissionRecord =
          conversation.messages.some(
            (message) => message.role === "user" && message.text === text,
          ) ||
          conversation.queuedMessages?.some((message) => message.text === text);
        if (!hasAdmissionRecord) this.releaseQuestionAnswer(conversation, id);
      });
      throw error;
    }
  }

  private async checkSteeredMessage(request: OperationRequest) {
    const conversation = this.store.conversation(requiredString(request, "id"));
    const id = requiredString(request, "messageId");
    const message = conversation.queuedMessages?.find((item) => item.id === id);
    if (
      !message?.steering ||
      message.status !== "uncertain" ||
      this.steering.has(conversation.id)
    )
      throw new Error("There is no uncertain follow-up to check");
    const { nativeTurnId } = message.steering;
    const adapter = await this.ensureController(conversation);
    const itemId = await adapter.findSteeredItem(nativeTurnId, id);
    const result = await this.store.change(() => {
      this.assertCurrent(conversation);
      const current = conversation.queuedMessages?.find(
        (item) => item.id === id,
      );
      if (!current || itemId) {
        if (current?.steering && itemId) {
          this.recordSteeredItem(conversation, current, itemId);
          this.clearSteeredDraft(conversation, current);
        }
        return { status: "delivered" };
      }
      if (!current.steering) return { status: "queued" };
      if (
        this.controllers.get(conversation.id) !== adapter ||
        adapter.activeTurnIdentity() === nativeTurnId
      )
        throw new Error(
          "The turn may still accept the follow-up. Check again after it ends.",
        );
      this.clearSteeredDraft(conversation, current);
      if (questionAnswers(current.text).length) {
        conversation.queuedMessages = conversation.queuedMessages!.filter(
          (message) => message.id !== current.id,
        );
        this.confirmQuestionAnswers(conversation, current.text);
        return { status: "not-delivered" };
      }
      delete current.steering;
      current.status = "queued";
      conversation.queuePaused = true;
      return { status: "queued" };
    });
    if (result.status === "delivered") this.scheduleQueue(conversation.id);
    return result;
  }

  private markSteerUncertain(conversation: ConversationState): void {
    for (const message of conversation.queuedMessages ?? [])
      if (message.steering) message.status = "uncertain";
  }

  private async sendToolResult(
    request: OperationRequest,
  ): Promise<{ id: string; status: "accepted"; nativeTurnId: string }> {
    const id = requiredString(request, "id");
    const conversation = this.store.conversation(id);
    this.assertCurrent(conversation);
    if (conversation.provider !== "codex")
      throw new Error("Tool results are only supported in Codex conversations");
    const name = requiredString(request, "name").trim();
    const namespace =
      request.namespace === undefined
        ? null
        : requiredString(request, "namespace").trim();
    if (
      !name ||
      name.length > 256 ||
      namespace === "" ||
      (namespace?.length ?? 0) > 256
    )
      throw new Error(
        "Tool name and optional namespace must contain 1–256 characters",
      );
    const output = request.output;
    if (typeof output !== "string" || output.length > 1_000_000)
      throw new Error(
        "Tool output must be a string of at most 1,000,000 characters",
      );

    this.pendingToolResults.set(id, (this.pendingToolResults.get(id) ?? 0) + 1);
    try {
      // Preserve transactions already admitted before this result arrived.
      await this.store.serialize(() => undefined);
      this.assertCurrent(conversation);
      const adapter = await this.ensureController(conversation);
      this.assertCurrent(conversation);
      const nativeTurnId = await adapter.sendToolResult(
        { name, namespace, output },
        this.activeTurns.has(id),
      );
      return { id, status: "accepted", nativeTurnId };
    } finally {
      const remaining = this.pendingToolResults.get(id)! - 1;
      if (remaining) this.pendingToolResults.set(id, remaining);
      else {
        this.pendingToolResults.delete(id);
        this.scheduleQueue(id);
      }
    }
  }

  async interruptConversation(id: string): Promise<{ id: string }> {
    const conversation = this.store.conversation(id);
    const adapter = this.controllers.get(id);
    if (!adapter)
      throw new Error("Conversation has no running provider controller");
    await adapter.cancel();
    return { id: conversation.id };
  }

  async answerPermission(request: OperationRequest): Promise<{ id: string }> {
    const conversation = this.store.conversation(requiredString(request, "id"));
    const adapter = this.controllers.get(conversation.id);
    if (!adapter)
      throw new Error("Conversation has no running provider controller");
    await adapter.permission(
      requiredString(request, "requestId"),
      requiredString(request, "optionId"),
    );
    return { id: conversation.id };
  }

  providerEvent(id: string, event: ProviderEvent, at = Date.now()): void {
    if (this.store.closing || event.type === "diagnostic") return;
    const conversation = this.store.data.conversations.find(
      (item) => item.id === id,
    );
    if (!conversation) return;
    if (event.type === "background") {
      const activities = conversation.backgroundActivities ?? [];
      const next = activities.filter((item) => item.id !== event.removeId);
      const index = next.findIndex((item) => item.id === event.activity.id);
      if (index < 0) next.push(event.activity);
      else next[index] = event.activity;
      conversation.backgroundActivities = next.slice(-64);
      this.store.notify(true);
      if (event.activity.state === "running")
        this.store.scheduleConversationCheckpoint(id);
      else this.store.schedulePersist(true);
      return;
    }
    const resume = this.resumeContexts.get(id);
    if (resume) {
      if (event.type === "state" && event.state === "starting")
        conversation.status = "starting";
      if (conversation.provider === "codex" && event.type === "history") {
        stageCodexSnapshot(
          resume,
          event.details,
          undefined,
          conversation.nativeId,
        );
      } else if (conversation.provider === "kimi") {
        stageKimiEvent(resume, event);
      }
      this.store.notify(true);
      return;
    }
    switch (event.type) {
      case "turn-started":
        this.beginTurn(conversation);
        this.activeTurns.add(id);
        this.externalTurns.add(id);
        conversation.error = undefined;
        break;
      case "state": {
        const clock = this.turnClocks.get(id);
        const turn = conversation.turns?.find((turn) => turn.id === clock?.id);
        if (clock && turn && !turn.finishedAt) {
          const now = performance.now() - Math.max(0, Date.now() - at);
          if (event.state === "working" && clock.workingStart === undefined)
            clock.workingStart = now;
          else if (
            event.state !== "working" &&
            clock.workingStart !== undefined
          ) {
            clock.worked += now - clock.workingStart;
            clock.workingStart = undefined;
          }
        }
        conversation.status = event.state;
        if (event.state === "failed" || event.state === "closed")
          conversation.backgroundActivities =
            backgroundWithUnknownState(conversation);
        break;
      }
      case "text":
        if (event.role === "user" && event.itemId && event.clientId) {
          const message = conversation.queuedMessages?.find(
            (item) =>
              item.id === event.clientId &&
              item.steering?.nativeTurnId === event.nativeTurnId,
          );
          if (message) {
            this.recordSteeredItem(conversation, message, event.itemId);
            break;
          }
          const steeredId = `codex/${conversation.nativeId}/${event.nativeTurnId}/${event.itemId}`;
          if (conversation.messages.some((item) => item.id === steeredId))
            break;
        }
        if (!event.replay) {
          const id = event.itemId
            ? `codex/live/${conversation.nativeId}/${event.itemId}`
            : randomUUID();
          const existing = event.itemId
            ? conversation.messages.find((message) => message.id === id)
            : undefined;
          if (
            event.role === "user" &&
            event.itemId &&
            questionAnswers(event.text).length
          ) {
            const prior = conversation.messages.find(
              (message) =>
                message.role === "user" &&
                !message.id.includes("/") &&
                message.text === event.text &&
                message.turnId === this.currentTurn(conversation),
            );
            this.confirmQuestionAnswers(conversation, event.text);
            if (prior) {
              prior.id = id;
              break;
            }
          }
          const last = conversation.messages.at(-1);
          const lastToolOrder = Math.max(
            0,
            ...conversation.tools.map((tool) => tool.order),
          );
          if (existing) {
            if (event.role === "assistant") existing.text += event.text;
          } else if (
            !event.itemId &&
            last?.role === event.role &&
            last.turnId === this.currentTurn(conversation) &&
            !last.origin &&
            last.order >= lastToolOrder
          ) {
            last.text += event.text;
          } else {
            conversation.messages.push({
              id,
              role: event.role,
              turnId: this.currentTurn(conversation),
              text: event.text,
              order: this.nextOrder(conversation),
            });
          }
        }
        break;
      case "message-meta": {
        const messageId = `codex/live/${conversation.nativeId}/${event.itemId}`;
        let message = conversation.messages.find(
          (message) => message.id === messageId,
        );
        if (!message) {
          message = {
            id: messageId,
            role: "assistant",
            text: "",
            order: this.nextOrder(conversation),
            turnId: this.currentTurn(conversation),
          };
          conversation.messages.push(message);
        }
        if (event.phase) message.phase = event.phase;
        if (event.interactive) message.interactive = true;
        if (event.questions?.length) message.questions = event.questions;
        if (!message.text && event.text) message.text = event.text;
        break;
      }
      case "tool":
        if (!event.replay) this.mergeLiveTool(conversation, event);
        break;
      case "permission":
        conversation.pendingPermissions.push({
          id: event.requestId,
          options: event.options,
          details: event.details,
        });
        break;
      case "permission-resolved":
        conversation.pendingPermissions =
          conversation.pendingPermissions.filter(
            (permission) => permission.id !== event.requestId,
          );
        break;
      case "completed":
        this.markSteerUncertain(conversation);
        this.finishTurn(conversation, event.outcome.status, at);
        if (event.outcome.status === "cancelled")
          conversation.queuePaused = true;
        this.scheduleQueue(id);
        if (this.externalTurns.delete(id)) this.activeTurns.delete(id);
        if (event.outcome.status === "completed") {
          conversation.completionRevision =
            (conversation.completionRevision ?? 0) + 1;
        }
        if (event.outcome.status === "cancelled") {
          this.addApplicationMessage(conversation, "Turn interrupted.");
        }
        break;
      case "error":
        this.markSteerUncertain(conversation);
        this.finishTurn(conversation, "failed", at);
        conversation.queuePaused = true;
        if (this.externalTurns.delete(id)) this.activeTurns.delete(id);
        conversation.status = "failed";
        conversation.error = event.message;
        this.addApplicationMessage(
          conversation,
          `Provider failed: ${event.message}`,
        );
        break;
      case "history":
        return;
    }
    this.store.notify(true);
    if (
      event.type === "message-meta" ||
      event.type === "tool" ||
      (event.type === "text" && event.role === "assistant")
    ) {
      this.store.scheduleConversationCheckpoint(id);
      return;
    }
    this.store.schedulePersist(
      event.type === "completed" ||
        event.type === "error" ||
        (event.type === "state" &&
          ["ready", "failed", "waiting"].includes(event.state)),
    );
  }

  mergeLiveTool(
    conversation: ConversationState,
    event: Extract<ProviderEvent, { type: "tool" }>,
  ): void {
    const details = object(event.details);
    const nativeId =
      typeof details.id === "string"
        ? details.id
        : typeof details.toolCallId === "string"
          ? details.toolCallId
          : undefined;
    const existing = nativeId
      ? conversation.tools.find((tool) => tool.id.endsWith(`/${nativeId}`))
      : undefined;
    const status = details.status;
    const completed = status === "completed" || status === "failed";
    if (existing) {
      existing.details = { ...object(existing.details), ...details };
      existing.phase = completed ? "completed" : event.phase;
    } else {
      conversation.tools.push({
        id: `live/${conversation.nativeId}/${nativeId ?? randomUUID()}`,
        turnId: this.currentTurn(conversation),
        phase: completed ? "completed" : event.phase,
        details: event.details,
        order: this.nextOrder(conversation),
      });
    }
  }

  nextOrder(conversation: ConversationState): number {
    return (
      Math.max(
        0,
        ...conversation.messages.map((message) => message.order),
        ...conversation.tools.map((tool) => tool.order),
      ) + 1
    );
  }

  addApplicationMessage(conversation: ConversationState, text: string): void {
    conversation.messages.push({
      id: randomUUID(),
      role: "system",
      turnId: this.currentTurn(conversation),
      text,
      order: this.nextOrder(conversation),
      origin: "application",
    });
  }

  isCurrent(conversation: ConversationState): boolean {
    return (
      !this.store.closing &&
      this.store.data.conversations.includes(conversation)
    );
  }

  assertCurrent(conversation: ConversationState): void {
    if (!this.isCurrent(conversation))
      throw new Error("Conversation was closed");
  }

  async disposeController(
    id: string,
    removedOwner?: ConversationState["detachedOwner"],
  ): Promise<void> {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const adapter = this.controllers.get(id);
    this.controllers.delete(id);
    this.activeTurns.delete(id);
    this.externalTurns.delete(id);
    this.resumeContexts.delete(id);
    const conversation = this.store.data.conversations.find(
      (item) => item.id === id,
    );
    const cursor = conversation?.detachedOwner ?? removedOwner;
    if (adapter) await adapter.dispose();
    else if (cursor) await this.detached?.owner.release(id, cursor);
    if (conversation) delete conversation.detachedOwner;
  }

  checkTransferReadiness(conversation: ConversationState): void {
    if (
      this.isActive(conversation.id) ||
      this.controllerInitializations.has(conversation.id)
    )
      throw new Error(
        "Finish the current Codex activity before moving this chat",
      );
  }

  async handle(request: OperationRequest, trustedUi = false): Promise<unknown> {
    switch (request.op) {
      case "conversation.discover": {
        const provider = providerId(request);
        const workspace = this.store.workspace(
          requiredString(request, "workspace"),
        );
        const cwd =
          typeof request.cwd === "string"
            ? path.resolve(request.cwd)
            : (workspace.folders[0] ?? process.env.HOME ?? process.cwd());
        const resolved = await resolveProviderExecutable(provider);
        const adapter = (
          provider === "codex" ? createCodexAdapter : createKimiAdapter
        )({ cwd, executable: resolved.executable, args: resolved.args });
        try {
          return await adapter.discover();
        } finally {
          await adapter.dispose();
        }
      }

      case "conversation.handoff":
        return this.handoffConversation(requiredString(request, "id"));

      case "conversation.reclaim":
        return this.reclaimConversation(requiredString(request, "id"));

      case "conversation.rename":
        return this.store.change(() => {
          const conversation = this.store.conversation(
            requiredString(request, "id"),
          );
          const name = requiredString(request, "name").trim();
          if (!name || name.length > 255)
            throw new Error("Name must contain 1-255 characters");
          conversation.displayName = name;
          return { id: conversation.id, name };
        });

      case "conversation.composer": {
        const versioned =
          trustedUi ||
          (typeof request.expectedVersion === "string" &&
            typeof request.writer === "string" &&
            request.writer.length <= 64);
        const textOnly = versioned && request.images === undefined;
        const save = textOnly
          ? (mutation: () => unknown) =>
              this.store.changeDraft(
                `composer:${requiredString(request, "workspace")}:${requiredString(request, "paneId")}`,
                mutation,
              )
          : (mutation: () => unknown) => this.store.change(mutation);
        return save(() => {
          const workspace = this.store.workspace(
            requiredString(request, "workspace"),
          );
          const pane = this.store.pane(
            workspace,
            requiredString(request, "paneId"),
          );
          if (
            pane.kind === "conversation" &&
            this.store.conversation(pane.conversationId).transfer
          )
            throw new Error("Resolve the pending move to Linux first");
          if (
            pane.kind !== "conversation" &&
            !(pane.kind === "document" && !pane.filePath)
          )
            throw new Error("Not a chat composer");
          const previous = workspace.chatDrafts?.[pane.id];
          const ownSubmittedVersion =
            previous?.text === "" &&
            !previous.images?.length &&
            !previous.localDraft &&
            previous.clearedFromVersion !== undefined &&
            previous.clearedFromVersion === request.expectedVersion &&
            typeof request.writer === "string" &&
            previous.writer === request.writer;
          if (
            versioned &&
            request.saveConflict !== true &&
            !ownSubmittedVersion &&
            typeof request.expectedVersion === "string" &&
            request.expectedVersion !== (previous?.version ?? "")
          )
            return {
              paneId: pane.id,
              conflict: true,
              draft: previous ?? { text: "" },
            };
          const text = typeof request.text === "string" ? request.text : "";
          if (text.length > 1_000_000)
            throw new Error("Composer draft is too long");
          const images =
            request.images === undefined
              ? (workspace.chatDrafts?.[pane.id]?.images ?? [])
              : this.validateImages(request.images);
          const skills = this.validateSkills(request.skills);
          const provider =
            request.provider === undefined
              ? previous?.provider
              : providerId(request);
          workspace.chatDrafts ??= {};
          if (versioned && request.saveConflict === true) {
            if (!previous)
              throw new Error("Conflicting draft is no longer available");
            workspace.chatDrafts[pane.id] = {
              ...previous,
              localDraft: {
                text,
                ...(provider ? { provider } : {}),
                ...(skills.length ? { skills } : {}),
                ...(request.images === undefined
                  ? {
                      images:
                        previous.localDraft?.images ?? previous.images ?? [],
                    }
                  : { images }),
              },
            };
            return {
              paneId: pane.id,
              version: previous.version,
              conflictSaved: true,
            };
          }
          const version = randomUUID();
          workspace.chatDrafts[pane.id] = {
            text,
            version,
            ...(previous?.cwd ? { cwd: previous.cwd } : {}),
            ...(provider === previous?.provider && previous?.initialSelection
              ? { initialSelection: previous.initialSelection }
              : {}),
            ...(!versioned && previous?.localDraft
              ? { localDraft: previous.localDraft }
              : {}),
            ...(versioned &&
            typeof request.writer === "string" &&
            request.writer.length <= 64
              ? { writer: request.writer }
              : {}),
            ...(provider ? { provider } : {}),
            ...(skills.length ? { skills } : {}),
            ...(images.length ? { images } : {}),
          };
          return { paneId: pane.id, version };
        });
      }

      case "conversation.acknowledge":
        return this.store.change(() => {
          const conversation = this.store.conversation(
            requiredString(request, "id"),
          );
          acknowledgeConversation(conversation);
          return { id: conversation.id };
        });

      case "conversation.report-status":
        return this.store.change(() => {
          const conversation = this.store.conversation(
            requiredString(request, "id"),
          );
          const status = requiredString(request, "status");
          if (
            !["working", "waiting", "review", "ready", "failed"].includes(
              status,
            )
          )
            throw new Error("Unsupported task status");
          if (request.source === "hook" && conversation.taskStatus === "review")
            return { id: conversation.id, taskStatus: conversation.taskStatus };
          conversation.taskStatus = status as ConversationState["taskStatus"];
          conversation.taskStatusContext =
            typeof request.context === "string"
              ? request.context.slice(0, 1000)
              : undefined;
          conversation.taskStatusUpdatedAt = new Date().toISOString();
          return { id: conversation.id, taskStatus: conversation.taskStatus };
        });

      case "conversation.draft-options":
      case "conversation.draft-option":
        return this.draftOptions(
          request,
          request.op === "conversation.draft-option",
        );

      case "conversation.options": {
        const conversation = this.store.conversation(
          requiredString(request, "id"),
        );
        if (conversation.status === "failed")
          throw new Error("Conversation failed. Send explicitly to retry.");
        return (await this.ensureController(conversation)).getOptions();
      }

      case "conversation.option": {
        if (request.option !== "model" && request.option !== "reasoning")
          throw new Error("Unknown provider option");
        const conversation = this.store.conversation(
          requiredString(request, "id"),
        );
        const adapter = await this.ensureController(conversation);
        const result = await adapter.setOption({
          option: request.option,
          value: requiredString(request, "value"),
        });
        if (conversation.initialSelection) {
          conversation.initialSelection = adapter.getSelection();
          this.store.schedulePersist(true);
        }
        return result;
      }

      case "conversation.start":

      case "conversation.create":
        return this.createConversation(request, false);

      case "conversation.resume":
        return this.createConversation(request, true);

      case "conversation.send":
        return this.sendConversation(request, false, trustedUi);

      case "conversation.send-tool-result":
        return this.sendToolResult(request);

      case "conversation.answer-question":
        return this.answerQuestion(request);

      case "conversation.check-steer":
        return this.checkSteeredMessage(request);

      case "conversation.queue-edit":
      case "conversation.queue-remove":
        return this.store
          .change(() => {
            const conversation = this.store.conversation(
              requiredString(request, "id"),
            );
            const message = conversation.queuedMessages?.find(
              (m) => m.id === requiredString(request, "messageId"),
            );
            if (!message) throw new Error("Queued message not found");
            if (message.status === "sending" || message.steering)
              throw new Error(
                "Check the follow-up delivery before changing this message",
              );
            if (request.op === "conversation.queue-remove") {
              conversation.queuedMessages = conversation.queuedMessages!.filter(
                (m) => m !== message,
              );
            } else {
              if (message.status !== "queued")
                throw new Error(
                  "Delivery is uncertain; inspect native history before resending",
                );
              const text =
                typeof request.text === "string" ? request.text : message.text;
              if (text.length > 1_000_000 || parseProviderCommand(text))
                throw new Error("Invalid queued prompt");
              const images =
                request.images === undefined
                  ? message.images
                  : this.validateImages(request.images);
              if (!text.trim() && !images?.length)
                throw new Error("Message must not be blank");
              message.text = text;
              message.editing = request.editing === true;
              message.images = images;
              if (request.skills !== undefined)
                message.skills = this.validateSkills(request.skills);
            }
            return { id: conversation.id, messageId: message.id };
          })
          .then((result) => {
            this.scheduleQueue(result.id);
            return result;
          });
      case "conversation.queue-resume": {
        const conversation = this.store.conversation(
          requiredString(request, "id"),
        );
        if (conversation.queuedMessages?.some((m) => m.status !== "queued"))
          throw new Error(
            "Resolve the uncertain message before continuing the queue",
          );
        await this.ensureController(conversation);
        await this.store.change(() => {
          conversation.queuePaused = false;
          conversation.error = undefined;
        });
        this.scheduleQueue(conversation.id);
        return { id: conversation.id };
      }

      case "conversation.interrupt":
        return this.interruptConversation(requiredString(request, "id"));

      case "conversation.permission":
        return this.answerPermission(request);

      case "conversation.native-inspect": {
        const section = requiredString(request, "section");
        if (
          !["status", "skills", "plugins", "config", "agents"].includes(section)
        )
          throw new Error("Unknown native inspection section");
        const adapter = await this.ensureController(
          this.store.conversation(requiredString(request, "id")),
        );
        return adapter.inspect(
          section as import("../providers/inspection").InspectionSection,
        );
      }
      case "conversation.earlier-history":
        return this.earlierHistory(requiredString(request, "id"));
      case "conversation.history-output":
        return this.historyOutput(
          requiredString(request, "id"),
          requiredString(request, "toolId"),
        );
      case "conversation.inspect":
        return structuredClone(
          this.store.conversation(requiredString(request, "id")),
        );

      default:
        throw new Error("Unknown conversation operation");
    }
  }

  private trackDetachedTurn(conversation: ConversationState): void {
    this.activeTurns.add(conversation.id);
    this.externalTurns.add(conversation.id);
    const turn = conversation.turns?.at(-1);
    if (!turn || turn.finishedAt) return;
    const start =
      performance.now() - Math.max(0, Date.now() - Date.parse(turn.startedAt));
    this.turnClocks.set(conversation.id, {
      id: turn.id,
      start,
      worked: turn.durationMs ?? 0,
      workingStart:
        conversation.status === "working"
          ? start + (turn.elapsedMs ?? 0)
          : undefined,
    });
  }

  async restoreInterrupted(): Promise<void> {
    await Promise.all(
      this.store.data.conversations.map(async (conversation) => {
        const active =
          ["starting", "working", "waiting"].includes(conversation.status) ||
          hasRunningBackground(conversation);
        if (conversation.queuedMessages?.length) {
          conversation.queuePaused = true;
          for (const message of conversation.queuedMessages)
            if (message.status === "sending") message.status = "uncertain";
        }
        const cursor = conversation.detachedOwner;
        if (cursor && this.detached) {
          const turn = conversation.turns?.at(-1);
          if (active && turn && !turn.finishedAt)
            this.trackDetachedTurn(conversation);
          try {
            const adapter = await this.detached.owner.reconnect(
              conversation.id,
              conversation.provider,
              conversation.nativeId,
              cursor,
              (event, recovered, at) => {
                if (this.store.closing) return;
                conversation.detachedOwner = recovered;
                this.providerEvent(conversation.id, event, at);
              },
            );
            this.controllers.set(conversation.id, adapter);
            if (
              adapter.activeTurnIdentity() &&
              (!this.activeTurns.has(conversation.id) ||
                !["working", "waiting"].includes(conversation.status) ||
                conversation.error !== undefined)
            ) {
              // The connected owner can have a live turn after the saved
              // desktop turn ended. Preserve completed history and track the
              // recovered turn without releasing or replacing its controller.
              if (conversation.status !== "waiting")
                conversation.status = conversation.pendingPermissions.length
                  ? "waiting"
                  : "working";
              if (!this.activeTurns.has(conversation.id))
                this.trackDetachedTurn(conversation);
              conversation.error = undefined;
              this.store.schedulePersist(true);
            }
            return;
          } catch (error) {
            if (error instanceof LocalOwnerUnavailable)
              delete conversation.detachedOwner;
            this.finishTurn(conversation, "failed");
            this.externalTurns.delete(conversation.id);
            this.activeTurns.delete(conversation.id);
          }
        }
        conversation.backgroundActivities =
          backgroundWithUnknownState(conversation);
        if (active) {
          conversation.status = "failed";
          conversation.pendingPermissions = [];
          conversation.error = conversation.detachedOwner
            ? "The detached chat could not reconnect. Quit Cod to stop its owner before resuming."
            : cursor
              ? "Detached session owner stopped; send explicitly to resume the saved conversation."
              : "Turn interrupted by app shutdown; send explicitly to resume.";
          this.addApplicationMessage(conversation, conversation.error);
        }
      }),
    );
  }
}
