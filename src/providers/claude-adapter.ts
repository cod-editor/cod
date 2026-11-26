import { randomUUID } from "node:crypto";
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  discoverClaudeSessions,
  openClaudeSession,
  readClaudeSession,
} from "./claude-native.ts";
import { ProviderOptionError } from "./option-error.ts";
import type {
  AdapterOptions,
  Conversation,
  ImageAttachment,
  InspectionSection,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEvent,
  ProviderOptions,
  ProviderSelection,
  TurnOutcome,
} from "./types.ts";

type EventBody = ProviderEvent extends infer E
  ? E extends ProviderEvent
    ? Omit<E, "provider" | "nativeId">
    : never
  : never;
type PermissionCallback = NonNullable<Options["canUseTool"]>;
type PermissionResult = NonNullable<Awaited<ReturnType<PermissionCallback>>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  readonly capabilities: ProviderCapabilities = {
    nativeResume: true,
    permissions: true,
    cancel: true,
    discovery: true,
    modelSelection: true,
    modeSelection: false,
    history: "native-replay",
    caveats: ["Claude Code uses its native permission mode and history."],
  };
  private id: string | null = null;
  private closed = false;
  private failure?: Error;
  private native?: Awaited<ReturnType<typeof openClaudeSession>>;
  private opening?: ReturnType<typeof openClaudeSession>;
  private reading?: Promise<void>;
  private disposal?: Promise<void>;
  private input = deferred<SDKUserMessage | undefined>();
  private active?: ReturnType<typeof deferred<TurnOutcome>>;
  private submission?: { id: string; accepted(): void };
  private interrupting = false;
  private listeners = new Set<(event: ProviderEvent) => void>();
  private permissions = new Map<string, (result: PermissionResult) => void>();
  private streamedItem?: string;
  private sentText = new Set<string>();
  private model?: string;

  private readonly options: AdapterOptions;

  constructor(options: AdapterOptions) {
    this.options = options;
    if (options.onEvent) this.listeners.add(options.onEvent);
  }

  get nativeId() {
    return this.id;
  }

  subscribe(listener: (event: ProviderEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EventBody) {
    const envelope = {
      ...event,
      provider: this.provider,
      nativeId: this.id,
    } as ProviderEvent;
    for (const listener of this.listeners) {
      try {
        listener(envelope);
      } catch {
        /* A listener cannot interrupt the native session. */
      }
    }
  }

  async discover(): Promise<Conversation[]> {
    return (await discoverClaudeSessions(this.options.cwd)).map((item) => ({
      provider: this.provider,
      nativeId: item.sessionId,
      cwd: this.options.cwd,
      metadata: {
        title: item.customTitle ?? item.summary,
        preview: item.firstPrompt,
        updatedAt: item.lastModified,
      },
    }));
  }

  create() {
    return this.bind(randomUUID(), undefined);
  }

  async resume(id: string) {
    const history = await readClaudeSession(this.options.cwd, id);
    if (!history && this.options.unrecordedClaudeId !== id)
      throw new Error(
        "Claude Code has no saved session with that ID in this directory",
      );
    return this.bind(id, history);
  }

  private async bind(
    id: string,
    history: Awaited<ReturnType<typeof readClaudeSession>>,
  ): Promise<Conversation> {
    if (this.id || this.closed)
      throw new Error("Claude Code controller is already bound");
    if (!this.options.executable)
      throw new Error("Claude Code executable is unavailable");
    this.id = id;
    this.opening = openClaudeSession(
      {
        cwd: this.options.cwd,
        executable: this.options.executable,
        args: this.options.args,
        env: this.options.env,
        nativeId: id,
        resume: Boolean(history),
        canUseTool: this.canUseTool,
      },
      this.inputs(),
    );
    this.emit({ type: "state", state: "starting" });
    this.native = await this.opening;
    this.opening = undefined;
    try {
      await this.native.ready;
    } catch {
      throw new Error("Could not open the native Claude Code session");
    }
    if (this.closed) {
      await this.native.dispose();
      throw new Error("Claude Code controller was closed");
    }
    if (history) this.emit({ type: "history", details: history.messages });
    this.reading = this.read();
    this.emit({ type: "state", state: "ready" });
    return {
      provider: this.provider,
      nativeId: id,
      cwd: this.options.cwd,
      metadata: {
        unrecorded: !history,
        title: history?.session.customTitle ?? history?.session.summary,
      },
    };
  }

  private async *inputs() {
    while (!this.closed && !this.failure) {
      const message = await this.input.promise;
      if (!message || this.closed || this.failure) return;
      this.input = deferred<SDKUserMessage | undefined>();
      yield message;
    }
  }

  private async read() {
    try {
      for await (const message of this.query()) this.nativeEvent(message);
      if (!this.closed) throw new Error();
    } catch {
      if (!this.closed) {
        this.failure = new Error("The native Claude Code connection ended");
        this.active?.reject(this.failure);
        this.active = undefined;
        this.submission = undefined;
        this.input.resolve(undefined);
        for (const settle of this.permissions.values())
          settle({ behavior: "deny", message: this.failure.message });
        this.emit({ type: "error", message: this.failure.message });
      }
    }
  }

  private nativeEvent(event: SDKMessage) {
    if (
      event.type === "user" &&
      "isReplay" in event &&
      event.isReplay &&
      event.session_id === this.id
    )
      this.acceptPrompt(event.uuid);
    if (event.type === "system" && event.subtype === "init") {
      this.model = event.model;
      return;
    }
    if (event.type === "stream_event" && !event.parent_tool_use_id) {
      if (event.event.type === "message_start")
        this.streamedItem = event.event.message.id;
      if (
        event.event.type === "content_block_delta" &&
        event.event.delta.type === "text_delta"
      ) {
        if (this.streamedItem) this.sentText.add(this.streamedItem);
        this.emit({
          type: "text",
          role: "assistant",
          itemId: this.streamedItem,
          text: event.event.delta.text,
          replay: false,
        });
      }
      return;
    }
    if (event.type === "assistant" && !event.parent_tool_use_id) {
      for (const item of event.message.content) {
        if (item.type === "text" && !this.sentText.has(event.message.id))
          this.emit({
            type: "text",
            role: "assistant",
            itemId: event.message.id,
            text: item.text,
            replay: false,
          });
        else if (item.type === "tool_use")
          this.emit({
            type: "tool",
            phase: "started",
            replay: false,
            details: {
              toolCallId: item.id,
              kind: item.name,
              title: item.name,
              input: item.input,
            },
          });
      }
      return;
    }
    if (event.type === "user")
      for (const item of Array.isArray(event.message.content)
        ? event.message.content
        : []) {
        if (item.type === "tool_result")
          this.emit({
            type: "tool",
            phase: "completed",
            replay: false,
            details: {
              toolCallId: item.tool_use_id,
              output: item.content,
              status: item.is_error ? "failed" : "completed",
            },
          });
      }
    if (event.type !== "result" || !this.active) return;
    const active = this.active;
    this.active = undefined;
    const interrupted = this.interrupting;
    this.interrupting = false;
    if (
      event.session_id === this.id &&
      !event.is_error &&
      event.user_message_uuid
    )
      this.acceptPrompt(event.user_message_uuid);
    this.submission = undefined;
    if (event.session_id !== this.id || (event.is_error && !interrupted)) {
      const message =
        event.session_id !== this.id
          ? "Claude Code returned a different native session"
          : "Claude Code could not complete the turn. Check native authentication and availability.";
      this.emit({ type: "error", message });
      active.reject(new Error(message));
      return;
    }
    const outcome: TurnOutcome = {
      status: interrupted ? "cancelled" : "completed",
      nativeReason: event.subtype,
    };
    this.emit({ type: "completed", outcome });
    this.emit({ type: "state", state: "ready" });
    active.resolve(outcome);
  }

  private acceptPrompt(id: string) {
    if (this.submission?.id !== id) return;
    const submission = this.submission;
    this.submission = undefined;
    submission.accepted();
  }

  private readonly canUseTool: PermissionCallback = (
    tool,
    input,
    { signal, toolUseID },
  ) => {
    if (signal.aborted || this.closed)
      return Promise.resolve({
        behavior: "deny",
        message: "Claude Code permission request closed",
      });
    return new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID();
      const close = () =>
        finish({
          behavior: "deny",
          message: "Claude Code permission request closed",
        });
      const finish = (result: PermissionResult) => {
        if (!this.permissions.delete(requestId)) return;
        signal.removeEventListener("abort", close);
        this.emit({ type: "permission-resolved", requestId });
        if (!this.closed && !this.failure)
          this.emit({ type: "state", state: "working" });
        resolve({ ...result, toolUseID });
      };
      this.permissions.set(requestId, finish);
      signal.addEventListener("abort", close, { once: true });
      this.emit({
        type: "permission",
        requestId,
        options: [
          { id: "allow", label: "Allow once", kind: "allow_once" },
          { id: "deny", label: "Deny", kind: "reject_once" },
        ],
        details: { title: tool, input },
      });
      this.emit({ type: "state", state: "waiting" });
    });
  };

  async permission(id: string, choice: string) {
    const settle = this.permissions.get(id);
    if (!settle || (choice !== "allow" && choice !== "deny"))
      throw new Error(
        "That Claude Code permission choice is no longer available",
      );
    settle(
      choice === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: "User declined" },
    );
  }

  private query() {
    if (this.failure) throw this.failure;
    if (!this.native || this.closed)
      throw new Error("Claude Code controller is not ready");
    return this.native.query;
  }

  async send(
    text: string,
    images: ImageAttachment[] = [],
    skills: Array<{ name: string; path: string }> = [],
    submission?: { id: string; accepted(): void },
  ) {
    this.query();
    if (this.active) throw new Error("Claude Code is already working");
    if (skills.length)
      throw new Error("Claude Code skill references are not supported in Cod");
    this.sentText.clear();
    this.streamedItem = undefined;
    const content: SDKUserMessage["message"]["content"] = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...images.map((image) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.mimeType,
          data: image.data,
        },
      })),
    ];
    this.active = deferred<TurnOutcome>();
    this.submission = submission;
    const result = this.active.promise;
    this.emit({ type: "state", state: "working" });
    this.input.resolve({
      type: "user",
      uuid: submission?.id as SDKUserMessage["uuid"],
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
    return result;
  }

  async cancel() {
    if (!this.active) throw new Error("Claude Code has no active response");
    this.interrupting = true;
    await this.query()
      .interrupt()
      .catch((error) => {
        this.interrupting = false;
        throw error;
      });
  }

  dispose() {
    return (this.disposal ??= this.close().catch((error) => {
      this.disposal = undefined;
      throw error;
    }));
  }

  private async close() {
    this.closed = true;
    for (const settle of this.permissions.values())
      settle({ behavior: "deny", message: "Controller closed" });
    this.active?.reject(new Error("Claude Code controller closed"));
    this.active = undefined;
    this.input.resolve(undefined);
    const native = this.native ?? (await this.opening?.catch(() => undefined));
    await native?.dispose();
    await this.reading;
  }

  async getOptions(): Promise<ProviderOptions> {
    const models = await this.query().supportedModels();
    return {
      models: models.map(({ value, displayName }) => ({
        value,
        label: displayName,
      })),
      reasoning: [],
      current: this.getSelection(),
      selectionEffect: "immediate",
    };
  }

  async getDraftOptions(): Promise<ProviderOptions> {
    throw new ProviderOptionError(
      "unavailable",
      "Select a model in the opened Claude Code session",
    );
  }

  getSelection() {
    return this.model ? { model: this.model } : {};
  }

  async setOption(selection: ProviderSelection) {
    if (selection.option !== "model")
      throw new ProviderOptionError(
        "invalid-selection",
        "Claude Code effort is not selectable in Cod",
      );
    if (this.active)
      throw new ProviderOptionError(
        "busy",
        "Wait until Claude Code finishes the turn",
      );
    const options = await this.getOptions();
    if (!options.models.some(({ value }) => value === selection.value))
      throw new ProviderOptionError(
        "invalid-selection",
        "Choose a model returned by Claude Code",
      );
    await this.query().setModel(selection.value);
    this.model = selection.value;
    return { ...options, current: this.getSelection() };
  }

  async inspect(section: InspectionSection) {
    if (!this.id) throw new Error("Open a Claude Code session first");
    return {
      section,
      provider: this.provider,
      nativeId: this.id,
      fields:
        section === "status"
          ? [
              { label: "Native session", value: this.id },
              { label: "Working directory", value: this.options.cwd },
            ]
          : [],
      entries: [],
      unavailable:
        section === "status"
          ? []
          : ["Use the native Claude Code terminal for this information."],
    };
  }

  async resolveSkills(
    _text: string,
    skills: Array<{ name: string; path: string }> = [],
  ): Promise<Array<{ name: string; path: string }>> {
    if (skills.length)
      throw new Error("Claude Code skill references are not supported in Cod");
    return [];
  }
  activeTurnIdentity() {
    return undefined;
  }
  async steer(): Promise<"unsupported"> {
    return "unsupported";
  }
  async findSteeredItem() {
    return null;
  }
  async sendToolResult(): Promise<string> {
    throw new Error("Claude Code tool output is provider-owned");
  }
}
