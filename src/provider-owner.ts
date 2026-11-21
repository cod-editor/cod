import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { startCommandSocket } from "./application/command-socket";
import { requiredString } from "./application/request";
import { createCodexAdapter, createKimiAdapter } from "./providers";
import { ProviderOptionError } from "./providers/option-error";
import type { ProviderAdapter } from "./providers/types";
import {
  localOwnerSocket,
  maximumOwnerFrame,
  ownerMethods,
  ownerProtocol,
  type LocalOwnerFrame,
  type LocalOwnerReply,
  type LocalOwnerState,
  type OwnerMethod,
} from "./providers/local-owner-protocol";
import type { OperationRequest } from "./types";

const maximumReplayPerChat = 4 * 1024 * 1024;
const maximumChats = 32;

class OwnedChat {
  readonly generation = randomUUID();
  readonly listeners = new Set<Socket>();
  private sequence = 0;
  private droppedThrough = 0;
  private bufferedBytes = 0;
  private backlog: Array<{ sequence: number; frame: string; bytes: number }> =
    [];
  constructor(readonly adapter: ProviderAdapter) {
    adapter.subscribe((event) => {
      if (event.type === "diagnostic") return;
      const sequence = ++this.sequence;
      const frame =
        JSON.stringify({
          type: "event",
          sequence,
          at: Date.now(),
          event,
          activeTurnId: this.adapter.activeTurnIdentity(),
        } satisfies LocalOwnerFrame) + "\n";
      const bytes = Buffer.byteLength(frame);
      this.backlog.push({ sequence, frame, bytes });
      this.bufferedBytes += bytes;
      while (this.bufferedBytes > maximumReplayPerChat) {
        const dropped = this.backlog.shift()!;
        this.bufferedBytes -= dropped.bytes;
        this.droppedThrough = dropped.sequence;
      }
      for (const listener of this.listeners) this.write(listener, frame);
    });
  }

  get state(): LocalOwnerState {
    let selection: LocalOwnerState["selection"];
    try {
      selection = this.adapter.getSelection();
    } catch {
      // A newly allocated controller has no native session or model yet.
    }
    return {
      nativeId: this.adapter.nativeId,
      activeTurnId: this.adapter.activeTurnIdentity(),
      selection,
      capabilities: this.adapter.capabilities,
    };
  }

  watch(connection: Socket, sequence: number) {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < this.droppedThrough ||
      sequence > this.sequence
    )
      throw new Error(
        "Detached chat output no longer fits the recovery buffer",
      );
    const state = this.state;
    this.write(
      connection,
      JSON.stringify({
        type: "ready",
        protocol: ownerProtocol,
        cursor: { generation: this.generation, sequence },
        through: this.sequence,
        state,
      } satisfies LocalOwnerFrame) + "\n",
    );
    for (const event of this.backlog) {
      if (event.sequence > sequence) this.write(connection, event.frame);
    }
    this.listeners.add(connection);
    connection.once("close", () => this.listeners.delete(connection));
  }

  async call(method: OwnerMethod, args: unknown[]): Promise<LocalOwnerReply> {
    const action = this.adapter[method] as
      ((...values: unknown[]) => Promise<unknown>) | undefined;
    try {
      if (!action)
        throw new Error("This provider does not support the operation");
      const value = await action.apply(this.adapter, args);
      return { ok: true, value, state: this.state, through: this.sequence };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ProviderOptionError
          ? { optionCode: error.code }
          : {}),
      };
    }
  }

  async dispose() {
    await this.adapter.dispose();
    for (const listener of this.listeners) listener.end();
  }

  private write(connection: Socket, value: string) {
    if (
      connection.writableLength + Buffer.byteLength(value) >
      maximumOwnerFrame
    )
      connection.destroy();
    else connection.write(value);
  }
}

async function main() {
  const profile = process.argv[2];
  const socket = await localOwnerSocket(profile!, true);
  const chats = new Map<string, OwnedChat>();
  let stopping = false;
  const owned = (request: OperationRequest) => {
    const id = requiredString(request, "id");
    const chat = chats.get(id);
    if (!chat || chat.generation !== request.generation)
      throw new Error("The detached chat owner is no longer available");
    return chat;
  };
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;

  const server = await startCommandSocket(
    socket,
    async (request) => {
      if (stopping) throw new Error("The detached chat owner is stopping");
      if (request.op === "owner.ping") return { protocol: ownerProtocol };
      if (request.op === "owner.stop") {
        await stop();
        return { stopped: true };
      }
      if (request.op === "owner.add") {
        const id = requiredString(request, "id");
        if (chats.has(id)) throw new Error("This chat already has an owner");
        if (chats.size >= maximumChats)
          throw new Error("Detached chat limit reached");
        if (request.provider !== "codex" && request.provider !== "kimi")
          throw new Error("Unsupported detached chat provider");
        if (
          request.args !== undefined &&
          (!Array.isArray(request.args) ||
            request.args.some((arg) => typeof arg !== "string"))
        )
          throw new Error("Invalid provider arguments");
        const options = {
          executable: requiredString(request, "executable"),
          args: request.args as string[] | undefined,
          cwd: requiredString(request, "cwd"),
          env: {
            ...environment,
            COD_CONVERSATION_ID: id,
            COD_WORKSPACE_ID: requiredString(request, "workspace"),
            COD_SOCKET_PATH: requiredString(request, "commandSocket"),
            COD_DATA_DIR: profile,
            COD_CLI_PATH: requiredString(request, "cli"),
            COD_NODE_PATH: requiredString(request, "node"),
          },
        };
        const chat = new OwnedChat(
          request.provider === "codex"
            ? createCodexAdapter(options)
            : createKimiAdapter(options),
        );
        chats.set(id, chat);
        return { generation: chat.generation, sequence: 0 };
      }
      if (request.op === "owner.release") {
        const id = requiredString(request, "id");
        const chat = chats.get(id);
        if (!chat || chat.generation !== request.generation)
          return { stopped: false };
        await chat.dispose();
        if (chats.get(id) === chat) chats.delete(id);
        return { stopped: true };
      }
      const chat = owned(request);
      if (
        request.op !== "owner.call" ||
        !ownerMethods.includes(request.method as OwnerMethod) ||
        !Array.isArray(request.args)
      )
        throw new Error("Invalid detached provider operation");
      return chat.call(request.method as OwnerMethod, request.args);
    },
    async (connection, request) => {
      if (stopping) throw new Error("The detached chat owner is stopping");
      owned(request).watch(connection, Number(request.sequence));
    },
  );
  async function stop() {
    if (stopping) return;
    stopping = true;
    server.close();
    await Promise.allSettled([...chats.values()].map((chat) => chat.dispose()));
  }
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

void main().catch(() => {
  process.exitCode = 1;
});
