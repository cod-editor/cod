import { codexQuestions, questionAnswers } from "../codex-questions.ts";
import { codexHistoryTurns } from "../conversation-history.ts";
import {
  codexHistoryPage,
  codexLinkedHistoryProof,
  readCodexHistoryPage,
} from "./codex-history.ts";
import { CodexBackground } from "./codex-background.ts";
import { listCodexChildren } from "./codex-children.ts";
import { NativeInspection, type InspectionSection } from "./inspection.ts";
import { ProviderOptionError } from "./option-error.ts";
import { NativeSelection, readCodexDraftOptions } from "./selection.ts";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  RpcTransport,
  ProviderRpcError,
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
  DraftOptionChange,
  ToolResult,
  SteeringInput,
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
  outputReceived?: boolean;
  id?: string;
  external?: boolean;
  cancelRequested?: boolean;
  buffer: RpcMessage[];
  resolve(value: TurnOutcome): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
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
  private paginatedHistory = false;
  private codexVersion?: string;
  private active?: ActiveTurn;
  private steeringUnavailable = false;
  private finishedTurns = new Set<string>();
  private readonly background = new CodexBackground();
  private approvals = new Map<string, Approval>();
  private readonly controllerId = randomUUID();
  private permissionSequence = 0;
  private cwd: string;
  private selection: NativeSelection;
  private inspection = new NativeInspection();
  private optionsBusy = false;
  private selectionChanges = 0;
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
        if (this.provider === "codex") {
          const agent = string(object(initialized).userAgent);
          this.codexVersion = agent?.match(/^cod\/([^ ]+) /)?.[1];
          this.rpc.notify("initialized", {});
        } else if (object(initialized).protocolVersion !== 1) {
          throw new Error("Unsupported Kimi ACP protocol version");
        }
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
              ...(resumeId
                ? { threadId: resumeId, excludeTurns: true }
                : { ephemeral: false }),
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
      if (this.provider === "codex" && resumeId) {
        const thread = object(data.thread);
        this.paginatedHistory = thread.historyMode === "paginated";
        const page = await codexHistoryPage(
          this.rpc!,
          id,
          this.paginatedHistory,
        );
        data.turnsBackwardsCursor = null;
        data.itemsBackwardsCursor = page.nextCursor ?? null;
        this.emit({
          type: "history",
          details: {
            turns: codexHistoryTurns(page.items),
            historyMode: page.nextCursor ? "paginated" : "legacy",
          },
        });
      }
      this.state("ready");
      if (this.provider === "codex" && resumeId) this.reconcileCodexChildren();
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
  async earlierHistory(cursor: string) {
    this.ensureOpen();
    if (this.provider !== "codex" || !this.id || this.binding)
      throw new Error("Codex history requires a bound conversation");
    return codexHistoryPage(this.rpc!, this.id, this.paginatedHistory, cursor);
  }

  async historyOutput(turnId: string, itemId: string): Promise<unknown> {
    this.ensureOpen();
    if (this.provider !== "codex" || !this.id || this.binding)
      throw new Error("Codex history requires a bound conversation");
    const page = object(
      await this.rpc!.request(
        "thread/items/read",
        { threadId: this.id, turnId, itemIds: [itemId] },
        undefined,
        "history",
      ),
    );
    const entry = Array.isArray(page.data) ? object(page.data[0]) : {};
    if (
      entry.turnId !== turnId ||
      object(entry.item).id !== itemId ||
      entry.outputDeferred
    )
      throw new Error("Codex did not return the selected history output");
    return entry.item;
  }

  async codexRolloutPath(nativeId: string): Promise<string> {
    if (this.provider !== "codex" || this.id || this.binding)
      throw new Error(
        "Checking a saved Codex session requires an unbound client",
      );
    await this.initialize();
    const response = object(
      await this.rpc!.request(
        "thread/read",
        { threadId: nativeId, includeTurns: false },
        undefined,
        "read-only",
      ),
    );
    const thread = object(response.thread);
    const rollout = string(thread.path);
    if (thread.id !== nativeId || !rollout || !isAbsolute(rollout))
      throw new Error("Codex could not identify this saved session file");
    return rollout;
  }

  async supportsLinkedCodexTransfer(): Promise<boolean> {
    if (this.provider !== "codex") return false;
    await this.initialize();
    return this.codexVersion === "0.172.0";
  }

  async codexLinkedTransferProof(nativeId: string) {
    if (!(await this.supportsLinkedCodexTransfer()))
      throw new Error("Linked transfers require Codex 0.172.0");
    return codexLinkedHistoryProof(this.rpc!, nativeId);
  }

  async codexReindexLinkedTransfer(nativeId: string, lastTurnId: string) {
    if (this.id || this.binding || !(await this.supportsLinkedCodexTransfer()))
      throw new Error(
        "Linked transfer indexing requires an unbound Codex 0.172.0 client",
      );
    const result = object(
      await this.rpc!.request("thread/fork", {
        threadId: nativeId,
        cwd: this.cwd,
        lastTurnId,
        ephemeral: true,
        excludeTurns: true,
      }),
    );
    const fork = object(result.thread);
    const helperId = string(fork.id);
    if (!helperId || helperId === nativeId || fork.path !== null)
      throw new Error("Codex did not create a transient history index helper");
    const unsubscribed = object(
      await this.rpc!.request("thread/unsubscribe", {
        threadId: helperId,
      }),
    );
    if (unsubscribed.status !== "unsubscribed")
      throw new Error("Codex could not release the history index helper");
  }

  async codexDiscoverImportedThread(
    nativeId: string,
    rolloutPath: string,
  ): Promise<Conversation | undefined> {
    if (!(await this.supportsLinkedCodexTransfer())) return;
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = object(
        await this.rpc!.request("thread/list", {
          cwd: this.cwd,
          sourceKinds: [],
          limit: 100,
          useStateDbOnly: true,
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (!Array.isArray(page.data))
        throw new Error(
          "Codex returned invalid imported session discovery data",
        );
      for (const row of page.data) {
        const thread = object(row);
        if (
          thread.id === nativeId &&
          thread.path === rolloutPath &&
          thread.cwd === this.cwd
        )
          return { provider: "codex", nativeId, cwd: this.cwd, metadata: row };
      }
      cursor = string(page.nextCursor);
      if (cursor && cursors.has(cursor))
        throw new Error("Provider repeated an imported session cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
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
      (method, params) =>
        this.rpc!.request(
          method,
          params,
          undefined,
          section === "agents" ? "read-only" : undefined,
        ),
    );
  }
  async getDraftOptions(
    selection: ProviderOptions["current"],
    change?: DraftOptionChange,
  ): Promise<ProviderOptions> {
    if (this.provider !== "codex" || this.id || this.binding)
      throw new Error("Draft model discovery requires an unbound Codex client");
    await this.initialize();
    return readCodexDraftOptions(
      (method, params) =>
        this.rpc!.request(method, params, undefined, "read-only"),
      this.cwd,
      selection,
      change,
    );
  }
  getOptions() {
    return this.optionOperation(() =>
      this.selection.read((method, params) =>
        this.rpc!.request(method, params),
      ),
    );
  }
  getSelection(): ProviderOptions["current"] {
    this.ensureOpen();
    if (!this.id || this.binding)
      throw new ProviderOptionError(
        "not-ready",
        "The source chat model is not ready",
      );
    if (this.selectionChanges)
      throw new ProviderOptionError(
        "busy",
        "The source chat model is still changing",
      );
    return this.selection.snapshot();
  }
  async setOption(selection: ProviderSelection) {
    const captured = { ...selection };
    this.selectionChanges++;
    try {
      return await this.optionOperation(() =>
        this.selection.set(captured, this.id!, (method, params) =>
          this.rpc!.request(method, params),
        ),
      );
    } finally {
      this.selectionChanges--;
    }
  }
  async resolveSkills(
    text: string,
    selected: Array<{ name: string; path: string }> = [],
  ): Promise<Array<{ name: string; path: string }>> {
    if (this.provider === "codex" && questionAnswers(text).length) return [];
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

  private codexInput(
    text: string,
    images: NonNullable<SteeringInput["images"]>,
    skills: NonNullable<SteeringInput["skills"]>,
  ) {
    return [
      ...skills.map((skill) => ({ type: "skill", ...skill })),
      ...(text ? [{ type: "text", text }] : []),
      ...images.flatMap((image, index) => [
        { type: "text", text: `[Image ${image.reference ?? index + 1}]` },
        { type: "image", url: `data:${image.mimeType};base64,${image.data}` },
      ]),
    ];
  }

  activeTurnIdentity(): string | undefined {
    if (
      this.provider === "codex" &&
      !this.failure &&
      !this.closed &&
      !this.steeringUnavailable
    )
      return this.active?.cancelRequested ? undefined : this.active?.id;
  }

  async steer(
    { text, images = [], skills = [] }: SteeringInput,
    expectedTurnId: string,
    clientId: string,
  ): Promise<"accepted" | "uncertain" | "unsupported"> {
    if (this.provider !== "codex")
      throw new Error(
        "This provider does not support sending to the current turn",
      );
    this.ensureOpen();
    const resolvedSkills = await this.resolveSkills(text, skills);
    this.ensureOpen();
    if (!this.id || this.activeTurnIdentity() !== expectedTurnId)
      throw new Error("The selected turn is no longer active");
    try {
      const result = object(
        await this.rpc!.request(
          "turn/steer",
          {
            threadId: this.id,
            expectedTurnId,
            clientUserMessageId: clientId,
            input: this.codexInput(text, images, resolvedSkills),
          },
          undefined,
          "reconcile",
        ),
      );
      return result.turnId === expectedTurnId ? "accepted" : "uncertain";
    } catch (error) {
      if (error instanceof ProviderRpcError) {
        if (error.code === -32601) {
          this.steeringUnavailable = true;
          return "unsupported";
        }
        if (error.code === -32600 || error.code === -32602) throw error;
      }
      return "uncertain";
    }
  }

  private async findInCodexHistory(
    method: "thread/items/list" | "thread/turns/list",
    target: Record<string, unknown>,
    match: (row: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown> | null> {
    this.ensureOpen();
    if (this.provider !== "codex" || !this.id || this.binding)
      throw new Error("Codex history requires a bound conversation");
    const seen = new Set<string>();
    let cursor: string | undefined;
    while (seen.size < 20) {
      const page = await readCodexHistoryPage(
        this.rpc!,
        method,
        { threadId: this.id, ...target, cursor },
        30,
      );
      if (!Array.isArray(page.data) || !("nextCursor" in page))
        throw new Error("Codex did not confirm the selected turn history");
      const found = page.data.map(object).find(match);
      if (found) return found;
      if (page.nextCursor === null) return null;
      cursor = string(page.nextCursor);
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    throw new Error(
      "Codex could not finish checking the selected turn history",
    );
  }

  async findSteeredItem(
    turnId: string,
    clientId: string,
  ): Promise<string | null> {
    // Capture terminal state before reading items. A negative item lookup
    // while native work can still consume the input is not a rejection.
    const turn = await this.findInCodexHistory(
      "thread/turns/list",
      { itemsView: "summary" },
      (row) => row.id === turnId,
    );
    const match = await this.findInCodexHistory(
      "thread/items/list",
      { turnId, deferOutput: {} },
      (row) => {
        if (row.turnId !== turnId)
          throw new Error("Codex returned items from a different turn");
        const item = object(row.item);
        return item.type === "userMessage" && item.clientId === clientId;
      },
    );
    if (match) {
      const id = string(object(match.item).id);
      if (!id) throw new Error("Codex omitted the message identity");
      return id;
    }
    if (!["completed", "interrupted", "failed"].includes(String(turn?.status)))
      throw new Error(
        "Codex did not confirm that the selected turn has finished",
      );
    return null;
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
        // Codex acknowledges turn/start separately from native completion.
        // A quiet accepted turn is still owned until completion or disconnect.
        timer: this.provider === "kimi" ? this.kimiTurnTimer() : undefined,
      };
    });
    this.active = active;
    this.state("working");
    // Do not await acceptance before returning the completion promise: early notifications are buffered.
    void (async () => {
      try {
        if (this.provider === "codex") {
          const started = object(
            await this.rpc!.request("turn/start", {
              threadId: this.id,
              input: this.codexInput(text, images, resolvedSkills),
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
                  ...images.flatMap((image, index) => [
                    {
                      type: "text",
                      text: `[Image ${image.reference ?? index + 1}]`,
                    },
                    {
                      type: "image",
                      mimeType: image.mimeType,
                      data: image.data,
                    },
                  ]),
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
          else if (reason === "end_turn") {
            if (!active.outputReceived)
              throw new Error(
                "Kimi returned no response. Check account limits or continue in its CLI for details.",
              );
            this.finish({ status: "completed", nativeReason: reason });
          } else
            throw new Error(`Provider stopped before completion: ${reason}`);
        }
      } catch (error) {
        this.fail(errorOf(error));
      }
    })();
    return result;
  }
  async sendToolResult(
    result: ToolResult,
    requireDispatchedTurn: boolean,
  ): Promise<string> {
    this.ensureOpen();
    if (this.provider !== "codex")
      throw new Error("Tool results are only supported in Codex conversations");
    if (!this.id || this.binding)
      throw new Error("Create or resume a native conversation first");
    if (requireDispatchedTurn && !this.active)
      throw new Error("A message is being prepared for this conversation");

    try {
      const started = object(
        await this.rpc!.request("turn/start", {
          threadId: this.id,
          input: [],
          toolOutput: { ...result, retain: true },
          ...(this.active ? {} : this.selection.overrides()),
        }),
      );
      this.ensureOpen();
      const turnId = string(object(started.turn).id);
      if (!turnId) throw new Error("Provider omitted native turn identity");
      // Codex may respond before turn/started. Claim the accepted turn before
      // permitting a pending user message to start another turn.
      this.observeCodexTurnStart(turnId);
      return turnId;
    } catch (error) {
      throw new Error(
        `Tool result delivery was not confirmed. Inspect native history before resending. ${errorOf(error).message}`,
      );
    }
  }

  private observeCodexTurnStart(turnId: string): void {
    if (this.active || this.binding || this.finishedTurns.has(turnId)) return;
    this.active = {
      id: turnId,
      external: true,
      buffer: [],
      resolve: () => {},
      reject: () => {},
    };
    this.emit({ type: "turn-started", nativeTurnId: turnId });
    this.state("working");
  }

  private kimiTurnTimer() {
    return setTimeout(
      () => {
        this.fail(
          new Error("Provider turn timed out; controller must be resumed"),
        );
      },
      this.options.turnTimeoutMs ?? 60 * 60 * 1000,
    );
  }

  private reconcileCodexChildren(childId?: string) {
    const parentThreadId = this.id;
    const rpc = this.rpc;
    if (!rpc || !parentThreadId) return;
    void this.background
      .reconcileChildren(
        childId,
        () =>
          listCodexChildren(
            (method, params) => rpc.request(method, params, 5_000, "read-only"),
            parentThreadId,
            childId,
          ),
        (update) => this.emit({ type: "background", ...update }),
        () => !this.closed && !this.failure && this.id === parentThreadId,
      )
      .catch(() => {
        // Missing child lookup support does not affect ordinary chat or
        // direct subagent lifecycle events.
      });
  }

  private receive(message: RpcMessage) {
    if (this.closed || this.failure) return;
    const p = message.params;
    const origin = this.provider === "codex" ? p.threadId : p.sessionId;
    // Native activity can outlive its turn. Track it without admitting late
    // messages, approvals or turns from unrelated threads.
    if (this.provider === "codex" && this.id) {
      for (const update of this.background.finishTurn(this.id, message))
        this.emit({ type: "background", ...update });
      const update = this.background.observe(this.id, message, (childId) =>
        this.reconcileCodexChildren(childId),
      );
      if (update) this.emit({ type: "background", ...update });
    }
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
      // Native queue/goal continuations start without a Cod turn/start request.
      // Only an explicit start for our bound thread may establish ownership;
      // arbitrary late item events must never resurrect a finished turn.
      if (
        message.method === "turn/started" &&
        message.id === undefined &&
        turnId
      )
        this.observeCodexTurnStart(turnId);
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
        if (
          item.type === "userMessage" &&
          typeof item.id === "string" &&
          ((message.method === "item/started" &&
            (this.active?.external || typeof item.clientId === "string")) ||
            (message.method === "item/completed" &&
              Array.isArray(item.content) &&
              item.content.some((part) => {
                const content = string(object(part).text);
                return !!content && questionAnswers(content).length > 0;
              })))
        ) {
          this.emit({
            type: "text",
            role: "user",
            itemId: item.id,
            clientId: string(item.clientId),
            nativeTurnId: this.active?.id,
            text: (Array.isArray(item.content) ? item.content : [])
              .map(
                (part) =>
                  string(object(part).text) ??
                  `[Native ${string(object(part).type) ?? "non-text"} content]`,
              )
              .join("\n"),
            replay: false,
          });
        }
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
            ...(message.method === "item/completed"
              ? {
                  questions: codexQuestions(item.id, item.questions),
                  ...(typeof item.text === "string" ? { text: item.text } : {}),
                }
              : {}),
          });
        }
        if (
          [
            "commandExecution",
            "fileChange",
            "mcpToolCall",
            "dynamicToolCall",
            "functionCallOutput",
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
        if (
          kind === "agent_message_chunk" &&
          content.type === "text" &&
          typeof content.text === "string" &&
          content.text.trim() &&
          this.active
        )
          this.active.outputReceived = true;
        if (content.type === "text" && typeof content.text === "string")
          this.emit({
            type: "text",
            role: kind === "agent_message_chunk" ? "assistant" : "user",
            text: content.text,
            replay: this.replay,
          });
        else this.emit({ type: "history", details: update });
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        if (this.active) this.active.outputReceived = true;
        this.emit({
          type: "tool",
          phase: kind === "tool_call" ? "started" : "updated",
          details: update,
          replay: this.replay,
        });
      } else this.emit({ type: "history", details: update });
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
    if (active.id) {
      this.finishedTurns.add(active.id);
      if (this.finishedTurns.size > 128)
        this.finishedTurns.delete(this.finishedTurns.values().next().value!);
    }
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
