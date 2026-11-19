import {
  backgroundWithUnknownState,
  conversationHandoffReason,
} from "../conversation-actions";
import { parseProviderCommand } from "../provider-commands";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { stat } from "node:fs/promises";
import { resolveProviderExecutable } from "../provider-executables";
import { defaultSocketPath } from "../paths";
import {
  createCodexAdapter,
  createKimiAdapter,
  type ProviderAdapter,
  type ProviderEvent,
} from "../providers";
import {
  commitHistory,
  emptyHistory,
  stageCodexSnapshot,
  stageKimiEvent,
  type StagedHistory,
} from "../conversation-history";
import type {
  ConversationState,
  WorkspaceState,
  TerminalState,
  OperationRequest,
} from "../types";
import { ApplicationStateStore } from "./state";
import type { TerminalApplicationService } from "./terminal-service";
import { requiredString, providerId, object } from "./request";
import { leaf, replaceLeaf, removeLeaf, firstPane } from "./layout";
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
    outcome: "completed" | "cancelled" | "failed",
  ): void {
    const clock = this.turnClocks.get(conversation.id);
    const turn = conversation.turns?.find((turn) => turn.id === clock?.id);
    if (!turn || !clock || turn.finishedAt) return;
    turn.finishedAt = new Date().toISOString();
    const now = performance.now();
    turn.elapsedMs = Math.max(0, Math.round(now - clock.start));
    turn.durationMs = Math.max(
      0,
      Math.round(
        clock.worked +
          (clock.workingStart === undefined ? 0 : now - clock.workingStart),
      ),
    );
    turn.outcome = outcome;
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
      if (this.turnClocks.get(conversation.id)?.id === turnId)
        this.finishTurn(conversation, outcome.status);
    } catch (error) {
      if (this.turnClocks.get(conversation.id)?.id === turnId)
        this.finishTurn(conversation, "failed");
      throw error;
    } finally {
      this.store.schedulePersist(true);
    }
  }
  async freshHistory(conversation: ConversationState): Promise<StagedHistory> {
    const existing = this.controllers.get(conversation.id);
    const previousStatus = conversation.status;
    if (existing) {
      this.controllers.delete(conversation.id);
      await existing.dispose();
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
      await replay.resume(conversation.nativeId);
      return history;
    } finally {
      this.replays.delete(replay);
      await replay.dispose();
    }
  }
  async shutdown(): Promise<void> {
    for (const id of this.activeTurns) {
      const conversation = this.store.data.conversations.find(
        (item) => item.id === id,
      );
      if (conversation) {
        this.finishTurn(conversation, "cancelled");
        conversation.status = "failed";
        conversation.pendingPermissions = [];
        conversation.error =
          "Turn interrupted by app shutdown; send explicitly to resume.";
        this.addApplicationMessage(conversation, conversation.error);
      }
    }
    this.activeTurns.clear();
    this.externalTurns.clear();
    await Promise.all(
      [...this.controllers.values(), ...this.replays].map((adapter) =>
        adapter.dispose(),
      ),
    );
    this.controllers.clear();
  }
  async createConversation(
    request: OperationRequest,
    resume: boolean,
  ): Promise<{ id: string; paneId: string; nativeId: string }> {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const provider = providerId(request);
    const cwd = path.resolve(
      typeof request.cwd === "string"
        ? request.cwd
        : ((typeof request.paneId === "string"
            ? workspace.chatDrafts?.[request.paneId]?.cwd
            : workspace.chatDrafts?.[workspace.activePaneId]?.cwd) ??
            workspace.folders[0] ??
            process.env.HOME ??
            process.cwd()),
    );
    const nativeId = resume ? requiredString(request, "nativeId") : "";
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
      this.removeConversationRecord(
        conversation,
        restoreDraft,
        previousConversationId,
      );
      if (workspace.lastConversationId === id)
        workspace.lastConversationId = previousConversationId;
      await this.disposeController(id);
      await adapter?.dispose();
      this.store.notify();
      this.store.schedulePersist(true);
      throw error;
    } finally {
      this.resumeContexts.delete(id);
    }
  }

  removeConversationRecord(
    conversation: ConversationState,
    restoreDraft?: import("../types").DocumentPane,
    previousConversationId?: string,
  ): void {
    this.store.data.conversations = this.store.data.conversations.filter(
      (item) => item.id !== conversation.id,
    );
    const archive = this.store.data.closedWorkspaces?.find(
      (item) => item.workspace.id === conversation.workspaceId,
    );
    if (archive)
      archive.conversations = archive.conversations.filter(
        (item) => item.id !== conversation.id,
      );
    const workspace =
      this.store.data.workspaces.find(
        (item) => item.id === conversation.workspaceId,
      ) ?? archive?.workspace;
    if (!workspace || !conversation.paneId) return;
    workspace.panes = workspace.panes.filter(
      (pane) => pane.id !== conversation.paneId,
    );
    if (restoreDraft) {
      workspace.panes.push({ ...restoreDraft, draftChat: true });
      if (workspace.activePaneId === conversation.paneId)
        workspace.activePaneId = restoreDraft.id;
      if (workspace.lastConversationId === conversation.id)
        workspace.lastConversationId = previousConversationId;
      return;
    }
    workspace.layout =
      removeLeaf(workspace.layout, conversation.paneId) ?? leaf(randomUUID());
    if (!workspace.panes.length) {
      const paneId = randomUUID();
      workspace.panes.push({ id: paneId, kind: "document", draftChat: true });
      workspace.layout = leaf(paneId);
    }
    if (workspace.activePaneId === conversation.paneId) {
      workspace.activePaneId = firstPane(workspace.layout);
    }
  }

  attachConversation(
    workspace: WorkspaceState,
    conversationId: string,
  ): string {
    const active = this.store.pane(workspace, workspace.activePaneId);
    if (active.kind === "document" && !active.filePath) {
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
    workspace.layout = replaceLeaf(workspace.layout, workspace.activePaneId, {
      type: "split",
      direction: "right",
      ratio: 0.5,
      first: leaf(workspace.activePaneId),
      second: leaf(paneId),
    });
    workspace.activePaneId = paneId;
    return paneId;
  }

  async adapterFor(
    conversation: ConversationState,
    onEvent?: (event: ProviderEvent) => void,
  ): Promise<ProviderAdapter> {
    const resolved = await resolveProviderExecutable(conversation.provider);
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

  async loadController(
    conversation: ConversationState,
  ): Promise<ProviderAdapter> {
    if (conversation.handoffTerminalId)
      throw new Error(
        "Native CLI owns this session; return to chat explicitly after it exits",
      );
    this.assertCurrent(conversation);
    const existing = this.controllers.get(conversation.id);
    if (existing && conversation.status !== "failed") return existing;
    if (existing) {
      this.controllers.delete(conversation.id);
      await existing.dispose();
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
  ): Promise<{ id: string; status: string; messageId?: string }> {
    const conversation = this.store.conversation(requiredString(request, "id"));
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
      !fromQueue &&
      (this.isActive(conversation.id) || conversation.queuedMessages?.length)
    ) {
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
      if (!fromQueue)
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
          if (this.turnClocks.get(conversation.id)?.id === turnId) {
            this.finishTurn(conversation, outcome.status);
            this.activeTurns.delete(conversation.id);
          }
          finishPage("completed");
          if (outcome.status === "cancelled") conversation.queuePaused = true;
          this.finishQueued(
            conversation,
            fromQueue ? request : { op: "" },
            false,
          );
          this.store.schedulePersist(true);
        },
        (error) => {
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

  providerEvent(id: string, event: ProviderEvent): void {
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
      this.store.schedulePersist(event.activity.state !== "running");
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
          const now = performance.now();
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
        if (!event.replay) {
          const id = event.itemId
            ? `codex/live/${conversation.nativeId}/${event.itemId}`
            : randomUUID();
          const existing = event.itemId
            ? conversation.messages.find((message) => message.id === id)
            : undefined;
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
        this.finishTurn(conversation, event.outcome.status);
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
        this.finishTurn(conversation, "failed");
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

  async disposeController(id: string): Promise<void> {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const adapter = this.controllers.get(id);
    this.controllers.delete(id);
    this.activeTurns.delete(id);
    this.externalTurns.delete(id);
    this.resumeContexts.delete(id);
    await adapter?.dispose();
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
        const textOnly = trustedUi && request.images === undefined;
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
            trustedUi &&
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
          if (trustedUi && request.saveConflict === true) {
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
            ...(!trustedUi && previous?.localDraft
              ? { localDraft: previous.localDraft }
              : {}),
            ...(trustedUi &&
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
          conversation.taskStatusAcknowledgedAt =
            conversation.taskStatusUpdatedAt ?? new Date().toISOString();
          conversation.acknowledgedCompletionRevision =
            conversation.completionRevision ?? 0;
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
        return this.sendConversation(request);

      case "conversation.send-tool-result":
        return this.sendToolResult(request);

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
            if (message.status === "sending")
              throw new Error("Message is already being sent");
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
      case "conversation.inspect":
        return structuredClone(
          this.store.conversation(requiredString(request, "id")),
        );

      default:
        throw new Error("Unknown conversation operation");
    }
  }

  restoreInterrupted(): void {
    for (const conversation of this.store.data.conversations) {
      conversation.backgroundActivities =
        backgroundWithUnknownState(conversation);
      if (conversation.queuedMessages?.length) {
        conversation.queuePaused = true;
        for (const message of conversation.queuedMessages)
          if (message.status === "sending") message.status = "uncertain";
      }
      if (["starting", "working", "waiting"].includes(conversation.status)) {
        conversation.status = "failed";
        conversation.pendingPermissions = [];
        conversation.error =
          "Turn interrupted by app shutdown; send explicitly to resume.";
        this.addApplicationMessage(conversation, conversation.error);
      }
    }
  }
}
