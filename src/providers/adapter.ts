import { NativeInspection, type InspectionSection } from "./inspection.ts";
import { ProviderOptionError } from "./option-error.ts";
import { NativeSelection } from "./selection.ts";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  RpcTransport,
  errorOf,
  object,
  string,
  type RpcMessage,
  type RpcId,
} from "./transport.ts";
import type {
  AdapterOptions,
  Conversation,
  PermissionOption,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEvent,
  ProviderId,
  ProviderState,
  ProviderOptions,
  ProviderSelection,
  TurnOutcome,
} from "./types.ts";

type EventBody = ProviderEvent extends infer E
  ? E extends ProviderEvent
    ? Omit<E, "provider" | "nativeId">
    : never
  : never;
interface Approval {
  rpcId: RpcId;
  options: PermissionOption[];
  nativeOptions: Map<string, unknown>;
}
interface ActiveTurn {
  id?: string;
  cancelRequested?: boolean;
  buffer: RpcMessage[];
  resolve(value: TurnOutcome): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class NativeAdapter implements ProviderAdapter {
  readonly provider: ProviderId;
  readonly capabilities: ProviderCapabilities;
  private options: AdapterOptions;
  private listeners = new Set<(event: ProviderEvent) => void>();
  private rpc?: RpcTransport;
  private initialization?: Promise<void>;
  private binding = false;
  private replay = false;
  private closed = false;
  private failure?: Error;
  private id: string | null = null;
  private active?: ActiveTurn;
  private approvals = new Map<string, Approval>();
  private readonly controllerId = randomUUID();
  private permissionSequence = 0;
  private cwd: string;
  private selection: NativeSelection;
  private inspection = new NativeInspection();
  private optionsBusy = false;
  private optionWaiters: Array<() => void> = [];
  private cancellationSequence = 0;
  constructor(provider: ProviderId, options: AdapterOptions) {
    if (!isAbsolute(options.cwd))
      throw new Error("Provider cwd must be an absolute path");
    this.provider = provider;
    this.selection = new NativeSelection(provider);
    this.options = { ...options };
    this.cwd = options.cwd;
    if (options.onEvent) this.listeners.add(options.onEvent);
    this.capabilities = {
      nativeResume: true,
      permissions: true,
      cancel: true,
      discovery: true,
      modelSelection: true,
      modeSelection: false,
      history: provider === "codex" ? "native-snapshot" : "native-replay",
      caveats:
        provider === "kimi"
          ? [
              "Kimi default mode may permit native file edits without an approval request.",
              "ACP does not attach a turn ID to session updates. Native handoff requires one controller at a time.",
            ]
          : [
              "Only command-execution and file-change approvals are currently supported. Other native requests fail explicitly.",
            ],
    };
  }
  get nativeId() {
    return this.id;
  }
  subscribe(listener: (event: ProviderEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(event: EventBody) {
    const full = {
      provider: this.provider,
      nativeId: this.id,
      ...event,
    } as ProviderEvent;
    for (const listener of this.listeners) {
      // A UI listener must not break the protocol controller.
      try {
        listener(full);
      } catch {
        /* Consumer owns its listener errors. */
      }
    }
  }
  private state(state: ProviderState) {
    this.emit({ type: "state", state });
  }
  private ensureOpen() {
    if (this.closed) throw new Error("Provider adapter is disposed");
    if (this.failure) throw this.failure;
  }
  private fail(error: Error) {
    if (this.closed || this.failure) return;
    this.failure = error;
    this.finish(undefined, error);
    this.state("failed");
    this.emit({ type: "error", message: error.message });
    void this.rpc?.close();
  }
  private initialize(): Promise<void> {
    this.ensureOpen();
    if (!this.initialization)
      this.initialization = (async () => {
        this.state("starting");
        this.cwd = await realpath(this.options.cwd);
        this.ensureOpen();
        this.rpc = new RpcTransport(
          this.options,
          this.provider,
          this.provider === "codex" ? ["app-server", "--stdio"] : ["acp"],
          (message) => this.receive(message),
          (error) => this.fail(error),
          (message) => this.emit({ type: "diagnostic", message }),
        );
        const initialized = await this.rpc.request(
          "initialize",
          this.provider === "codex"
            ? {
                clientInfo: { name: "cod", version: "0.0.0" },
                capabilities: { experimentalApi: true },
              }
            : { protocolVersion: 1, clientCapabilities: {} },
        );
        if (this.provider === "codex") this.rpc.notify("initialized", {});
        else if (object(initialized).protocolVersion !== 1)
          throw new Error("Unsupported Kimi ACP protocol version");
      })().catch((error) => {
        this.fail(errorOf(error));
        throw error;
      });
    return this.initialization;
  }
  create() {
    return this.bind();
  }
  resume(nativeId: string) {
    if (!nativeId.trim())
      return Promise.reject(
        new Error("Native conversation identity is required"),
      );
    return this.bind(nativeId);
  }
  private async bind(resumeId?: string): Promise<Conversation> {
    this.ensureOpen();
    if (this.id || this.binding)
      throw new Error("Adapter already owns a conversation");
    this.binding = true;
    try {
      await this.initialize();
      // ACP replay is emitted during load, before its response arrives.
      if (resumeId) this.id = resumeId;
      this.replay = Boolean(resumeId);
      const result = await this.rpc!.request(
        this.provider === "codex"
          ? resumeId
            ? "thread/resume"
            : "thread/start"
          : resumeId
            ? "session/load"
            : "session/new",
        this.provider === "codex"
          ? {
              cwd: this.cwd,
              ...(resumeId ? { threadId: resumeId } : { ephemeral: false }),
            }
          : {
              cwd: this.cwd,
              mcpServers: [],
              ...(resumeId ? { sessionId: resumeId } : {}),
            },
      );
      const data = object(result);
      const returnedId =
        this.provider === "codex"
          ? string(object(data.thread).id)
          : string(data.sessionId);
      // ACP load is allowed to omit sessionId: its target is the request sessionId.
      const id =
        returnedId ?? (this.provider === "kimi" ? resumeId : undefined);
      if (!id || (resumeId && id !== resumeId))
        throw new Error(
          "Provider returned an unexpected native conversation identity",
        );
      this.id = id;
      this.selection.bind(data);
      if (this.provider === "codex" && resumeId)
        this.emit({ type: "history", details: data.thread });
      this.state("ready");
      return {
        provider: this.provider,
        nativeId: id,
        cwd: this.cwd,
        metadata: result,
      };
    } catch (error) {
      this.fail(errorOf(error));
      throw error;
    } finally {
      this.binding = false;
      this.replay = false;
    }
  }
  async discover(): Promise<Conversation[]> {
    await this.initialize();
    const result: Conversation[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = object(
        await this.rpc!.request(
          this.provider === "codex" ? "thread/list" : "session/list",
          {
            cwd: this.cwd,
            ...(this.provider === "codex"
              ? { sourceKinds: [], limit: 100 }
              : {}),
            ...(cursor ? { cursor } : {}),
          },
        ),
      );
      const rows = this.provider === "codex" ? page.data : page.sessions;
      if (!Array.isArray(rows))
        throw new Error(
          "Provider returned invalid conversation discovery data",
        );
      for (const row of rows) {
        const data = object(row);
        const id = string(this.provider === "codex" ? data.id : data.sessionId);
        if (id && (!data.cwd || data.cwd === this.cwd))
          result.push({
            provider: this.provider,
            nativeId: id,
            cwd: this.cwd,
            metadata: row,
          });
      }
      cursor = string(page.nextCursor);
      if (cursor && cursors.has(cursor))
        throw new Error("Provider repeated a discovery cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return result;
  }
  private async optionOperation(action: () => Promise<ProviderOptions>) {
    if (this.closed || this.failure || !this.id || this.binding)
      throw new ProviderOptionError(
        "not-ready",
        "A ready native conversation is required",
      );
    if (this.active || this.optionsBusy)
      throw new ProviderOptionError(
        "busy",
        "Provider options require an idle conversation",
      );
    this.optionsBusy = true;
    try {
      const result = await action();
      this.ensureOpen();
      return result;
    } catch (error) {
      if (error instanceof ProviderOptionError) throw error;
      throw new ProviderOptionError(
        "unavailable",
        "Native option state unavailable; reconnect or retry",
      );
    } finally {
      this.optionsBusy = false;
      for (const resolve of this.optionWaiters.splice(0)) resolve();
    }
  }
  async inspect(section: InspectionSection) {
    this.ensureOpen();
    if (!this.id || this.binding || !this.rpc)
      throw new Error("A connected native conversation is required");
    if (!["status", "skills", "plugins", "config", "agents"].includes(section))
      throw new Error("Unknown inspection section");
    return this.inspection.read(
      this.provider,
      this.id,
      this.cwd,
      section,
      (method, params) => this.rpc!.request(method, params),
    );
  }
  getOptions() {
    return this.optionOperation(() =>
      this.selection.read((method, params) =>
        this.rpc!.request(method, params),
      ),
    );
  }
  setOption(selection: ProviderSelection) {
    const captured = { ...selection };
    return this.optionOperation(() =>
      this.selection.set(captured, this.id!, (method, params) =>
        this.rpc!.request(method, params),
      ),
    );
  }
  async resolveSkills(
    text: string,
    selected: Array<{ name: string; path: string }> = [],
  ): Promise<Array<{ name: string; path: string }>> {
    const names = [
      ...new Set(
        [...text.matchAll(/(?:^|\s)\$([\w:.-]+)/g)].map((match) => match[1]!),
      ),
    ];
    if (!names.length && !selected.length) return [];
    if (this.provider !== "codex") {
      if (selected.length)
        throw new Error(
          "Native skill references are unavailable for this provider",
        );
      return [];
    }
    const catalog = (await this.inspect("skills")).entries.flatMap((entry) =>
      entry.skill ? [entry.skill] : [],
    );
    for (const skill of selected) {
      if (
        !names.includes(skill.name) ||
        !catalog.some(
          (entry) => entry.name === skill.name && entry.path === skill.path,
        )
      )
        throw new Error(`Selected skill is no longer available: ${skill.name}`);
      if (selected.filter((entry) => entry.name === skill.name).length > 1)
        throw new Error(`Choose one specific skill named ${skill.name}`);
    }
    return names.flatMap((name) => {
      const explicit = selected.find((entry) => entry.name === name);
      if (explicit) return [explicit];
      const matches = catalog.filter((entry) => entry.name === name);
      if (matches.length > 1)
        throw new Error(
          `Choose a specific skill named ${name}; several native paths match`,
        );
      return matches;
    });
  }

  async send(
    text: string,
    images: import("./types").ImageAttachment[] = [],
    selectedSkills: Array<{ name: string; path: string }> = [],
  ): Promise<TurnOutcome> {
    this.ensureOpen();
    const cancellationSequence = this.cancellationSequence;
    // Renderer metadata discovery can overlap an accepted prompt after resume.
    // Finish that native operation before starting inference or reading overrides.
    while (this.optionsBusy) {
      await new Promise<void>((resolve) => this.optionWaiters.push(resolve));
      this.ensureOpen();
    }
    if (!this.id || this.binding)
      throw new Error("Create or resume a native conversation first");
    if (this.active) throw new Error("A provider turn is already active");
    if (cancellationSequence !== this.cancellationSequence) {
      const outcome: TurnOutcome = {
        status: "cancelled",
        nativeReason: "cancelled-before-dispatch",
      };
      this.emit({ type: "completed", outcome });
      this.state("ready");
      return outcome;
    }
    if (!text.trim() && !images.length)
      throw new Error("Prompt must not be empty");
    const resolvedSkills = await this.resolveSkills(text, selectedSkills);
    this.ensureOpen();
    if (this.active) throw new Error("A provider turn is already active");
    if (cancellationSequence !== this.cancellationSequence) {
      const outcome: TurnOutcome = {
        status: "cancelled",
        nativeReason: "cancelled-before-dispatch",
      };
      this.emit({ type: "completed", outcome });
      this.state("ready");
      return outcome;
    }
    let active!: ActiveTurn;
    const result = new Promise<TurnOutcome>((resolve, reject) => {
      active = {
        buffer: [],
        resolve,
        reject,
        timer: setTimeout(
          () => {
            this.fail(
              new Error("Provider turn timed out; controller must be resumed"),
            );
            void this.rpc?.close();
          },
          this.options.turnTimeoutMs ?? 60 * 60 * 1000,
        ),
      };
    });
    this.active = active;
    this.state("working");
    // Do not await acceptance before returning the completion promise: early notifications are buffered.
    void (async () => {
      try {
        if (this.provider === "codex") {
          const skills = resolvedSkills.map((skill) => ({
            type: "skill",
            ...skill,
          }));
          const started = object(
            await this.rpc!.request("turn/start", {
              threadId: this.id,
              input: [
                ...skills,
                ...(text ? [{ type: "text", text }] : []),
                ...images.map((image) => ({
                  type: "image",
                  url: `data:${image.mimeType};base64,${image.data}`,
                })),
              ],
              ...this.selection.overrides(),
            }),
          );
          if (this.active !== active) return;
          active.id = string(object(started.turn).id);
          if (!active.id)
            throw new Error("Provider omitted native turn identity");
          const buffered = active.buffer.splice(0);
          for (const message of buffered) this.receive(message);
          if (this.active === active && active.cancelRequested)
            await this.cancel();
        } else {
          const response = object(
            await this.rpc!.request(
              "session/prompt",
              {
                sessionId: this.id,
                prompt: [
                  ...(text ? [{ type: "text", text }] : []),
                  ...images.map((image) => ({
                    type: "image",
                    mimeType: image.mimeType,
                    data: image.data,
                  })),
                ],
              },
              this.options.turnTimeoutMs ?? 60 * 60 * 1000,
            ),
          );
          if (this.active !== active) return;
          const reason = string(response.stopReason);
          if (!reason) throw new Error("Provider omitted native stop reason");
          if (reason === "cancelled")
            this.finish({ status: "cancelled", nativeReason: reason });
          else if (reason === "end_turn")
            this.finish({ status: "completed", nativeReason: reason });
          else throw new Error(`Provider stopped before completion: ${reason}`);
        }
      } catch (error) {
        this.fail(errorOf(error));
      }
    })();
    return result;
  }
  private receive(message: RpcMessage) {
    if (this.closed || this.failure) return;
    const p = message.params;
    const origin = this.provider === "codex" ? p.threadId : p.sessionId;
    if (origin !== this.id || !this.id) {
      if (message.id !== undefined)
        this.rpc?.reject(
          message.id,
          -32602,
          "Request does not belong to this conversation",
        );
      return;
    }
    if (
      this.provider === "codex" &&
      message.method === "thread/tokenUsage/updated"
    ) {
      this.inspection.updateUsage(p.tokenUsage);
      return;
    }
    if (
      this.provider === "kimi" &&
      message.method === "session/update" &&
      object(p.update).sessionUpdate === "usage_update"
    ) {
      this.inspection.updateUsage(p.update);
      return;
    }
    if (
      this.provider === "kimi" &&
      message.method === "session/update" &&
      object(p.update).sessionUpdate === "config_option_update"
    ) {
      this.selection.update(object(p.update).configOptions);
      return;
    }
    if (this.provider === "codex" && this.active && !this.active.id) {
      if (this.active.buffer.length >= 1000) {
        this.fail(new Error("Too many provider events before turn identity"));
        void this.rpc?.close();
        return;
      }
      this.active.buffer.push(message);
      return;
    }
    if (this.provider === "codex") {
      const turnId = string(p.turnId) ?? string(object(p.turn).id);
      if (!this.active || turnId !== this.active.id) {
        if (message.id !== undefined)
          this.rpc?.reject(
            message.id,
            -32602,
            "Request does not belong to the active turn",
          );
        return;
      }
    }
    if (message.id !== undefined) {
      this.requestPermission(message);
      return;
    }
    if (this.provider === "codex") {
      if (
        message.method === "item/agentMessage/delta" &&
        typeof p.delta === "string"
      )
        this.emit({
          type: "text",
          role: "assistant",
          text: p.delta,
          replay: false,
          itemId: string(p.itemId),
        });
      else if (
        message.method === "item/started" ||
        message.method === "item/completed"
      ) {
        const item = object(p.item);
        if (item.type === "agentMessage" && typeof item.id === "string") {
          this.emit({
            type: "message-meta",
            itemId: item.id,
            phase:
              item.phase === "commentary"
                ? "commentary"
                : item.phase === "partial_answer"
                  ? "partial"
                  : item.phase === "final_answer"
                    ? "final"
                    : undefined,
            interactive:
              Array.isArray(item.questions) && item.questions.length > 0,
            ...(message.method === "item/completed" &&
            typeof item.text === "string"
              ? { text: item.text }
              : {}),
          });
        }
        if (
          [
            "commandExecution",
            "fileChange",
            "mcpToolCall",
            "dynamicToolCall",
            "webSearch",
            "collabAgentToolCall",
          ].includes(String(item.type))
        )
          this.emit({
            type: "tool",
            phase: message.method === "item/started" ? "started" : "completed",
            details: item,
            replay: false,
          });
      } else if (message.method === "turn/completed") {
        const turn = object(p.turn);
        if (turn.status === "completed" || turn.status === "interrupted")
          this.finish({
            status: turn.status === "completed" ? "completed" : "cancelled",
            nativeReason: String(turn.status),
          });
        else
          this.fail(
            new Error(
              string(object(turn.error).message) ??
                `Native turn failed: ${String(turn.status)}`,
            ),
          );
      } else if (message.method === "error")
        this.emit({
          type: "diagnostic",
          message: string(object(p.error).message) ?? "Native provider error",
        });
    } else if (
      message.method === "session/update" &&
      (this.active || this.replay)
    ) {
      const update = object(p.update);
      const kind = update.sessionUpdate;
      if (kind === "agent_message_chunk" || kind === "user_message_chunk") {
        const content = object(update.content);
        if (content.type === "text" && typeof content.text === "string")
          this.emit({
            type: "text",
            role: kind === "agent_message_chunk" ? "assistant" : "user",
            text: content.text,
            replay: this.replay,
          });
        else this.emit({ type: "history", details: update });
      } else if (kind === "tool_call" || kind === "tool_call_update")
        this.emit({
          type: "tool",
          phase: kind === "tool_call" ? "started" : "updated",
          details: update,
          replay: this.replay,
        });
      else this.emit({ type: "history", details: update });
    }
  }
  private requestPermission(message: RpcMessage) {
    const id = message.id!;
    if ([...this.approvals.values()].some((request) => request.rpcId === id)) {
      this.rpc!.reject(id, -32600, "Duplicate permission request");
      return;
    }
    if (!this.active) {
      this.rpc!.reject(id, -32602, "No active turn");
      return;
    }
    const nativeOptions = new Map<string, unknown>();
    let options: PermissionOption[];
    if (
      this.provider === "codex" &&
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
      ].includes(message.method)
    ) {
      options = [
        { id: "allow_once", label: "Allow once", kind: "allow_once" },
        { id: "deny", label: "Deny", kind: "reject_once" },
      ];
      nativeOptions.set("allow_once", { decision: "accept" });
      nativeOptions.set("deny", { decision: "decline" });
    } else if (
      this.provider === "kimi" &&
      message.method === "session/request_permission"
    ) {
      const rows = message.params.options;
      if (!Array.isArray(rows)) {
        this.rpc!.reject(id, -32602, "Missing permission options");
        return;
      }
      options = rows.flatMap((row) => {
        const option = object(row);
        const key = string(option.optionId),
          label = string(option.name),
          kind = string(option.kind);
        if (!key || !label || !kind || nativeOptions.has(key)) return [];
        nativeOptions.set(key, {
          outcome: { outcome: "selected", optionId: key },
        });
        return [{ id: key, label, kind }];
      });
    } else {
      this.rpc!.reject(
        id,
        -32601,
        "This native request is not supported by Cod",
      );
      return;
    }
    if (!options.length) {
      this.rpc!.reject(id, -32602, "No valid permission options");
      return;
    }
    const requestId = `permission-${this.controllerId}-${++this.permissionSequence}`;
    this.approvals.set(requestId, { rpcId: id, options, nativeOptions });
    this.state("waiting");
    this.emit({
      type: "permission",
      requestId,
      options,
      details: message.params,
    });
  }
  async permission(requestId: string, optionId: string) {
    this.ensureOpen();
    const request = this.approvals.get(requestId);
    if (!request) throw new Error("Permission request is no longer pending");
    if (!request.nativeOptions.has(optionId))
      throw new Error("Unknown permission option");
    this.rpc!.respond(request.rpcId, request.nativeOptions.get(optionId));
    this.approvals.delete(requestId);
    this.emit({ type: "permission-resolved", requestId });
    if (!this.approvals.size && this.active) this.state("working");
  }
  async cancel() {
    this.ensureOpen();
    this.cancellationSequence += 1;
    if (!this.active) return;
    for (const [requestId, request] of this.approvals) {
      this.rpc!.respond(
        request.rpcId,
        this.provider === "kimi"
          ? { outcome: { outcome: "cancelled" } }
          : { decision: "decline" },
      );
      this.emit({ type: "permission-resolved", requestId });
    }
    this.approvals.clear();
    if (this.provider === "kimi")
      this.rpc!.notify("session/cancel", { sessionId: this.id });
    else {
      if (!this.active.id) {
        this.active.cancelRequested = true;
        return;
      }
      await this.rpc!.request("turn/interrupt", {
        threadId: this.id,
        turnId: this.active.id,
      });
    }
  }
  private finish(outcome?: TurnOutcome, error?: Error) {
    const active = this.active;
    this.active = undefined;
    for (const requestId of this.approvals.keys())
      this.emit({ type: "permission-resolved", requestId });
    this.approvals.clear();
    if (!active) return;
    clearTimeout(active.timer);
    if (error) active.reject(error);
    else if (outcome) {
      active.resolve(outcome);
      this.emit({ type: "completed", outcome });
      this.state("ready");
    }
  }
  async dispose() {
    if (!this.closed) {
      this.closed = true;
      this.finish(undefined, new Error("Provider adapter is disposed"));
      this.state("closed");
    }
    await this.rpc?.close();
  }
}
