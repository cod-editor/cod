import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CommandSocketError, invokeCommand } from "../command-client";
import type { OperationRequest } from "../types";
import {
  localOwnerSocket,
  localOwnerSockets,
  maximumOwnerFrame,
  ownerProtocol,
  ownerBuildMismatchExit,
  ownerUnavailable,
  type LocalOwnerCursor,
  type LocalOwnerFrame,
  type LocalOwnerReply,
  type LocalOwnerState,
  type OwnerMethod,
} from "./local-owner-protocol";
import { ProviderOptionError } from "./option-error";
import type {
  DraftOptionChange,
  ImageAttachment,
  ProviderAdapter,
  ProviderEvent,
  ProviderOptions,
  ProviderSelection,
  SteeringInput,
  ToolResult,
} from "./types";
import type { InspectionSection } from "./inspection";

type Provider = ProviderAdapter["provider"];
type OwnerEvent = (
  event: ProviderEvent,
  cursor: LocalOwnerCursor,
  at?: number,
) => void;
type SessionRequest = {
  id: string;
  provider: Provider;
  cwd: string;
  executable: string;
  args?: string[];
  workspace: string;
  commandSocket: string;
};
type Method = Required<Pick<ProviderAdapter, OwnerMethod>>;

function absent(error: unknown): boolean {
  return (
    error instanceof CommandSocketError &&
    !error.sent &&
    /ENOENT|ECONNREFUSED/.test(error.message)
  );
}

export class LocalOwnerUnavailable extends Error {}

export class LocalProviderOwner {
  private starting?: Promise<string>;
  private stopping = false;
  constructor(
    private readonly profile: string,
    private readonly build?: string,
  ) {}

  private async ping(socket: string, build?: string) {
    const reply = (await invokeCommand(
      socket,
      { op: "owner.ping" },
      { timeoutMs: 1_000 },
    )) as {
      protocol: number;
      build?: string;
    };
    if (reply.protocol !== ownerProtocol || reply.build !== build)
      throw new Error(
        "The running detached chat owner uses a different protocol",
      );
  }

  private async start(): Promise<string> {
    if (!this.build)
      throw new Error("The build of this detached chat owner is unknown");
    const socket = await localOwnerSocket(this.profile, this.build, true);
    try {
      await this.ping(socket, this.build);
      return socket;
    } catch (error) {
      if (!absent(error)) throw error;
    }
    const worker = spawn(
      process.execPath,
      [path.join(__dirname, "provider-owner.cjs"), this.profile, this.build],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    let failed = false;
    worker.once("error", () => {
      failed = true;
    });
    worker.unref();
    for (let retry = 0; retry < 40 && !failed; retry++) {
      await delay(50);
      if (worker.exitCode === ownerBuildMismatchExit)
        throw new Error("Reopen Cod to use the updated detached chat owner");
      try {
        await this.ping(socket, this.build);
        return socket;
      } catch (error) {
        if (!absent(error)) throw error;
      }
    }
    throw new Error("The detached chat owner did not start");
  }

  async open(
    session: SessionRequest,
    onEvent: OwnerEvent,
  ): Promise<DetachedProviderAdapter> {
    if (this.stopping) throw new Error("Cod is shutting down");
    const { socket, cursor } = await this.add(session).catch((error) => {
      // The last release can close the idle owner's socket between ping and add.
      // Retry only when the request never reached the owner or it refused it.
      if (
        absent(error) ||
        (error instanceof Error &&
          error.message === "The detached chat owner is stopping")
      )
        return this.add(session);
      throw error;
    });
    try {
      return await DetachedProviderAdapter.attach(
        socket,
        session.id,
        session.provider,
        cursor,
        onEvent,
      );
    } catch (error) {
      await invokeCommand(socket, {
        op: "owner.release",
        id: session.id,
        generation: cursor.generation,
      }).catch(() => undefined);
      throw error;
    }
  }

  private async add(session: SessionRequest) {
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    const socket = await this.starting;
    if (this.stopping) throw new Error("Cod is shutting down");
    const cursor = (await invokeCommand(socket, {
      op: "owner.add",
      ...session,
      node: process.execPath,
      cli: path.join(__dirname, "cli.cjs"),
    })) as LocalOwnerCursor;
    return { socket, cursor };
  }

  async reconnect(
    id: string,
    provider: Provider,
    nativeId: string,
    cursor: LocalOwnerCursor,
    onEvent: OwnerEvent,
  ) {
    try {
      const socket = await localOwnerSocket(this.profile, cursor.build);
      await this.ping(socket, cursor.build);
      return await DetachedProviderAdapter.attach(
        socket,
        id,
        provider,
        cursor,
        onEvent,
        nativeId,
      );
    } catch (error) {
      if (
        absent(error) ||
        (error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw new LocalOwnerUnavailable("The detached owner has stopped");
      throw error;
    }
  }

  async release(id: string, cursor: LocalOwnerCursor): Promise<void> {
    try {
      const socket = await localOwnerSocket(this.profile, cursor.build);
      await invokeCommand(socket, {
        op: "owner.release",
        id,
        generation: cursor.generation,
      });
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) &&
        !absent(error)
      )
        throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.starting?.catch(() => undefined);
    try {
      const sockets = await localOwnerSockets(this.profile);
      const results = await Promise.allSettled(
        sockets.map((socket) => invokeCommand(socket, { op: "owner.stop" })),
      );
      for (const result of results)
        if (result.status === "rejected" && !absent(result.reason))
          throw result.reason;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) &&
        !absent(error)
      )
        throw error;
    }
  }
}

export class DetachedProviderAdapter implements ProviderAdapter {
  private readonly listeners = new Set<
    (event: ProviderEvent, at?: number) => void
  >();
  private readonly pending = new AbortController();
  private watched?: Socket;
  private closed = false;
  private state!: LocalOwnerState;
  private readonly waiting = new Set<() => void>();

  private constructor(
    private readonly socket: string,
    private readonly id: string,
    readonly provider: Provider,
    readonly cursor: LocalOwnerCursor,
  ) {}

  static async attach(
    socket: string,
    id: string,
    provider: Provider,
    cursor: LocalOwnerCursor,
    onEvent: OwnerEvent,
    nativeId?: string,
  ): Promise<DetachedProviderAdapter> {
    const controller = new DetachedProviderAdapter(socket, id, provider, {
      ...cursor,
    });
    controller.listeners.add((event, at) =>
      onEvent(event, { ...controller.cursor }, at),
    );
    await controller.watch(nativeId);
    return controller;
  }

  private watch(nativeId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const connection = connect(this.socket);
      this.watched = connection;
      let buffer = "";
      let through: number | undefined;
      let attached = false;
      const interrupted = () => {
        connection.destroy();
        clearTimeout(deadline);
        if (this.closed) return;
        const message = "Connection to the detached chat owner was lost";
        if (!attached) reject(new Error(message));
        else {
          this.pending.abort();
          this.emit({
            type: "error",
            provider: this.provider,
            nativeId: this.nativeId,
            message,
          });
        }
      };
      const deadline = setTimeout(interrupted, 5_000);
      connection.setEncoding("utf8");
      connection.on("connect", () =>
        connection.write(
          JSON.stringify({
            op: "workspace.watch",
            id: this.id,
            ...this.cursor,
          }) + "\n",
        ),
      );
      connection.once("error", () => connection.destroy());
      connection.once("close", interrupted);
      connection.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > maximumOwnerFrame)
          return connection.destroy();
        for (
          let offset = buffer.indexOf("\n");
          offset >= 0;
          offset = buffer.indexOf("\n")
        ) {
          let frame: LocalOwnerFrame | { ok: false; error: string };
          try {
            frame = JSON.parse(buffer.slice(0, offset)) as typeof frame;
          } catch {
            return connection.destroy();
          }
          buffer = buffer.slice(offset + 1);
          if (!frame || typeof frame !== "object") return connection.destroy();
          if ("ok" in frame) {
            if (
              !attached &&
              frame.ok === false &&
              typeof frame.error === "string"
            ) {
              clearTimeout(deadline);
              reject(
                frame.error === ownerUnavailable
                  ? new LocalOwnerUnavailable(frame.error)
                  : new Error(frame.error),
              );
            }
            return connection.destroy();
          }
          if (frame.type === "ready" && through === undefined) {
            if (
              frame.protocol !== ownerProtocol ||
              frame.cursor.generation !== this.cursor.generation ||
              (nativeId !== undefined && frame.state.nativeId !== nativeId)
            )
              return connection.destroy();
            through = frame.through;
            this.state = frame.state;
          } else if (
            frame.type === "event" &&
            through !== undefined &&
            frame.sequence === this.cursor.sequence + 1
          ) {
            this.cursor.sequence = frame.sequence;
            // The ready frame already describes the owner's state through
            // this replay cursor. Only newer events may update that state.
            if (attached) {
              this.state.activeTurnId = frame.activeTurnId;
              if (frame.event.nativeId !== null)
                this.state.nativeId = frame.event.nativeId;
            }
            this.emit(frame.event, frame.at);
            for (const wake of this.waiting) wake();
          } else return connection.destroy();
          if (!attached && this.cursor.sequence === through) {
            attached = true;
            clearTimeout(deadline);
            resolve();
          }
        }
      });
    });
  }

  private emit(event: ProviderEvent, at?: number) {
    for (const listener of this.listeners) listener(event, at);
  }

  private async call<K extends OwnerMethod>(
    method: K,
    ...args: Parameters<Method[K]>
  ): Promise<Awaited<ReturnType<Method[K]>>> {
    const request: OperationRequest = {
      op: "owner.call",
      id: this.id,
      generation: this.cursor.generation,
      method,
      args,
    };
    const reply = (await invokeCommand(this.socket, request, {
      signal: this.pending.signal,
      timeoutMs: method === "send" ? null : undefined,
    })) as LocalOwnerReply;
    if (!reply.ok) {
      if (reply.optionCode)
        throw new ProviderOptionError(reply.optionCode, reply.message);
      throw new Error(reply.message);
    }
    await this.waitForEvents(reply.through);
    if (this.cursor.sequence === reply.through) this.state = reply.state;
    return reply.value as Awaited<ReturnType<Method[K]>>;
  }

  private async waitForEvents(through: number) {
    if (this.cursor.sequence >= through) return;
    this.pending.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = (failure?: Error) => {
        this.waiting.delete(advance);
        this.pending.signal.removeEventListener("abort", cancel);
        clearTimeout(deadline);
        if (failure) reject(failure);
        else resolve();
      };
      const advance = () => {
        if (this.cursor.sequence >= through) finish();
      };
      const cancel = () =>
        finish(new Error("Detached chat event connection was closed"));
      const deadline = setTimeout(cancel, 5_000);
      this.pending.signal.addEventListener("abort", cancel, { once: true });
      this.waiting.add(advance);
    });
  }

  get capabilities() {
    return this.state.capabilities;
  }
  get nativeId() {
    return this.state.nativeId;
  }
  getSelection() {
    if (!this.state.selection)
      throw new ProviderOptionError(
        "not-ready",
        "The source chat model is not ready",
      );
    return this.state.selection;
  }
  activeTurnIdentity() {
    return this.state.activeTurnId;
  }
  subscribe(listener: (event: ProviderEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  create() {
    return this.call("create");
  }
  resume(id: string) {
    return this.call("resume", id);
  }
  discover() {
    return this.call("discover");
  }
  inspect(section: InspectionSection) {
    return this.call("inspect", section);
  }
  earlierHistory(cursor: string) {
    return this.call("earlierHistory", cursor);
  }
  historyOutput(turnId: string, itemId: string) {
    return this.call("historyOutput", turnId, itemId);
  }
  getOptions() {
    return this.call("getOptions");
  }
  getDraftOptions(
    selection: ProviderOptions["current"],
    change?: DraftOptionChange,
  ) {
    return this.call("getDraftOptions", selection, change);
  }
  setOption(selection: ProviderSelection) {
    return this.call("setOption", selection);
  }
  resolveSkills(text: string, skills?: Array<{ name: string; path: string }>) {
    return this.call("resolveSkills", text, skills);
  }
  send(
    text: string,
    images?: ImageAttachment[],
    skills?: Array<{ name: string; path: string }>,
  ) {
    return this.call("send", text, images, skills);
  }
  steer(input: SteeringInput, turnId: string, clientId: string) {
    return this.call("steer", input, turnId, clientId);
  }
  findSteeredItem(turnId: string, clientId: string) {
    return this.call("findSteeredItem", turnId, clientId);
  }
  sendToolResult(result: ToolResult, requireDispatchedTurn: boolean) {
    return this.call("sendToolResult", result, requireDispatchedTurn);
  }
  permission(requestId: string, optionId: string) {
    return this.call("permission", requestId, optionId);
  }
  cancel() {
    return this.call("cancel");
  }

  detach(): void {
    this.closed = true;
    this.watched?.destroy();
    this.pending.abort();
  }
  async dispose() {
    this.detach();
    try {
      await invokeCommand(this.socket, {
        op: "owner.release",
        id: this.id,
        generation: this.cursor.generation,
      });
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
}
