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
    return this.activeTurns.has(id);
  }
  reserve(id: string): void {
    if (this.activeTurns.has(id))
      throw new Error("A turn is already active for this conversation");
    this.activeTurns.add(id);
  }
  release(id: string): void {
    this.activeTurns.delete(id);
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
    conversation.messages.push({
      id: messageId,
      turnId: this.beginTurn(conversation),
      role: "user",
      text,
      order: this.nextOrder(conversation),
    });
    this.store.notify();
    try {
      const outcome = await adapter.send(text);
      this.finishTurn(conversation, outcome.status);
    } catch (error) {
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
        : (workspace.folders[0] ?? process.env.HOME ?? process.cwd()),
    );
    if (!(await stat(cwd)).isDirectory())
      throw new Error("Working directory is not a directory");
    if (!this.store.data.workspaces.includes(workspace))
      throw new Error("Workspace was closed");
    const nativeId = resume ? requiredString(request, "nativeId") : "";
    if (
      resume &&
      this.store.data.conversations.some(
        (item) => item.provider === provider && item.nativeId === nativeId,
      )
    ) {
      throw new Error("That native conversation is already controlled by Cod");
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
    const conversation = this.store.conversation(id);
    if (conversation.handoffTerminalId)
      throw new Error("Conversation is already handed off");
    if (
      this.activeTurns.has(id) ||
      this.controllerInitializations.has(id) ||
      conversation.pendingPermissions.length ||
      conversation.status === "starting"
    )
      throw new Error(
        "Finish or interrupt the active turn before continuing in CLI",
      );
    const workspace = this.store.workspace(conversation.workspaceId);
    const terminalId = randomUUID();
    conversation.handoffTerminalId = terminalId;
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
    const loading = this.loadController(conversation);
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
    return value.map((item) => {
      const image = object(item);
      if (
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          String(image.mimeType),
        ) ||
        typeof image.data !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
      )
        throw new Error("Invalid image attachment");
      bytes += Buffer.byteLength(image.data, "base64");
      if (bytes > 20 * 1024 * 1024) throw new Error("Attachments exceed 20 MB");
      return {
        mimeType:
          image.mimeType as import("../providers/types").ImageAttachment["mimeType"],
        data: image.data,
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

  async sendConversation(
    request: OperationRequest,
  ): Promise<{ id: string; status: string }> {
    const conversation = this.store.conversation(requiredString(request, "id"));
    const text = typeof request.text === "string" ? request.text : "";
    if (parseProviderCommand(text))
      throw new Error(
        "Session commands are not prompts. Use conversation.native-inspect with a section, or open the desktop command menu.",
      );
    const images = this.validateImages(request.images);
    const skills = this.validateSkills(request.skills);
    if (!text.trim() && !images.length)
      throw new Error("Message must not be blank");
    if (this.activeTurns.has(conversation.id)) {
      throw new Error("A turn is already active for this conversation");
    }
    this.activeTurns.add(conversation.id);
    try {
      const adapter = await this.ensureController(conversation);
      await adapter.resolveSkills(text, skills);
      this.assertCurrent(conversation);
      conversation.messages.push({
        id: randomUUID(),
        turnId: this.beginTurn(conversation),
        role: "user",
        text,
        ...(images.length ? { images } : {}),
        order: this.nextOrder(conversation),
      });
      conversation.error = undefined;
      conversation.acknowledgedCompletionRevision =
        conversation.completionRevision ?? 0;
      this.store.notify();
      this.store.schedulePersist();
      const workspace = this.store.workspace(conversation.workspaceId);
      if (workspace.chatDrafts)
        delete workspace.chatDrafts[conversation.paneId];
      const turn = adapter.send(text, images, skills);
      const finishPage = (status: "completed" | "uncertain") =>
        this.views.finishPage(request, conversation.id, status);
      void turn.then(
        (outcome) => {
          this.finishTurn(conversation, outcome.status);
          finishPage("completed");
          this.activeTurns.delete(conversation.id);
          this.store.schedulePersist(true);
        },
        (error) => {
          this.finishTurn(conversation, "failed");
          finishPage("uncertain");
          this.activeTurns.delete(conversation.id);
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
      this.activeTurns.delete(conversation.id);
      throw error;
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
    if (this.store.closing) return;
    const conversation = this.store.data.conversations.find(
      (item) => item.id === id,
    );
    if (!conversation) return;
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
      this.store.notify();
      return;
    }
    switch (event.type) {
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
        break;
      }
      case "text":
        if (!event.replay && event.role === "assistant") {
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
            existing.text += event.text;
          } else if (
            !event.itemId &&
            last?.role === "assistant" &&
            last.turnId === this.currentTurn(conversation) &&
            !last.origin &&
            last.order >= lastToolOrder
          ) {
            last.text += event.text;
          } else {
            conversation.messages.push({
              id,
              role: "assistant",
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
        conversation.status = "failed";
        conversation.error = event.message;
        this.addApplicationMessage(
          conversation,
          `Provider failed: ${event.message}`,
        );
        break;
      case "history":
      case "diagnostic":
        break;
    }
    this.store.notify();
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
    this.resumeContexts.delete(id);
    await adapter?.dispose();
  }

  async handle(
    request: OperationRequest,
    _trustedUi = false,
  ): Promise<unknown> {
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

      case "conversation.composer":
        return this.store.change(() => {
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
          const text = typeof request.text === "string" ? request.text : "";
          if (text.length > 1_000_000)
            throw new Error("Composer draft is too long");
          const images = this.validateImages(request.images);
          const skills = this.validateSkills(request.skills);
          const provider =
            request.provider === undefined ? undefined : providerId(request);
          workspace.chatDrafts ??= {};
          workspace.chatDrafts[pane.id] = {
            text,
            ...(provider ? { provider } : {}),
            ...(skills.length ? { skills } : {}),
            ...(images.length ? { images } : {}),
          };
          return { paneId: pane.id };
        });

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

      case "conversation.options":
        return (
          await this.ensureController(
            this.store.conversation(requiredString(request, "id")),
          )
        ).getOptions();

      case "conversation.option": {
        if (request.option !== "model" && request.option !== "reasoning")
          throw new Error("Unknown provider option");
        return (
          await this.ensureController(
            this.store.conversation(requiredString(request, "id")),
          )
        ).setOption({
          option: request.option,
          value: requiredString(request, "value"),
        });
      }

      case "conversation.start":

      case "conversation.create":
        return this.createConversation(request, false);

      case "conversation.resume":
        return this.createConversation(request, true);

      case "conversation.send":
        return this.sendConversation(request);

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
