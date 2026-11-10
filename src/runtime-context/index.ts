import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

const PROTOCOL_VERSION = "2025-11-25";
const MAX_FRAME_BYTES = 1024 * 1024;
const RUNTIME_GUIDANCE =
  "Cod is the desktop harness. Use cliCommand and helpText as the installed command source. Target the bound workspace and conversation IDs explicitly; never substitute the currently focused resources. Only operations listed in capabilities and documented in helpText are supported. These tools are read-only and do not execute CLI commands.";

const TOOLS = [
  {
    name: "cod_context",
    description:
      "Read Cod desktop harness context before controlling the app. Retrieve this session's explicit workspace and conversation IDs, workspace folders, current supported operations, CLI command, and CLI help. Targets follow this conversation's current workspace, not the focused workspace.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "cod_help",
    description:
      "Read the actual Cod CLI help and current application capabilities. Use the supplied cliCommand with explicit workspace and conversation targets; operations absent from the returned capabilities or help are unsupported.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

type RequestId = string | number | null;

interface RuntimeContextOperationRequest {
  op: "state" | "capabilities";
}

export interface RuntimeContextOptions {
  workspaceId: string;
  conversationId: string;
  invoke(request: RuntimeContextOperationRequest): Promise<unknown>;
  cliCommand: string;
  helpText: string;
  input?: Readable;
  output?: Writable;
}

export interface RuntimeContextHandle {
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return (
    value === null || typeof value === "string" || typeof value === "number"
  );
}

class ContextTargetError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof ContextTargetError
    ? error.message
    : "Cod application operation failed";
}

class RuntimeContextServer implements RuntimeContextHandle {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private discardingFrame = false;
  private closed = false;
  private pendingWrites = 0;

  constructor(private readonly options: RuntimeContextOptions) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.input.on("data", this.handleData);
    this.input.on("end", this.close);
    this.input.on("error", this.close);
    this.output.on("error", this.handleOutputEnd);
    this.output.on("close", this.handleOutputEnd);
    if (this.input.readableEnded) queueMicrotask(this.close);
  }

  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.input.off("data", this.handleData);
    this.input.off("end", this.close);
    this.input.off("error", this.close);
    this.input.pause();
    this.buffer = "";
    this.decoder.end();
    this.detachOutputIfSettled();
  };

  private handleOutputEnd = (): void => {
    this.close();
    this.detachOutputIfSettled();
  };

  private detachOutputIfSettled(): void {
    if (!this.closed || this.pendingWrites > 0) return;
    this.output.off("error", this.handleOutputEnd);
    this.output.off("close", this.handleOutputEnd);
  }

  private handleData = (chunk: string | Buffer): void => {
    if (this.closed) return;
    let text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (this.discardingFrame) {
      const end = text.indexOf("\n");
      if (end === -1) return;
      text = text.slice(end + 1);
      this.discardingFrame = false;
    }
    this.buffer += text;

    let end = this.buffer.indexOf("\n");
    while (end !== -1) {
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      this.handleFrame(frame);
      if (this.closed) return;
      end = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME_BYTES) {
      this.buffer = "";
      this.discardingFrame = true;
      this.sendError(null, -32600, "Request frame exceeds the input limit");
    }
  };

  private handleFrame(frame: string): void {
    if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
      this.sendError(null, -32600, "Request frame exceeds the input limit");
      return;
    }

    let request: unknown;
    try {
      request = JSON.parse(frame);
    } catch {
      this.sendError(null, -32700, "Parse error");
      return;
    }
    if (
      !isRecord(request) ||
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string" ||
      ("id" in request && !isRequestId(request.id))
    ) {
      const id =
        isRecord(request) && "id" in request && isRequestId(request.id)
          ? request.id
          : null;
      this.sendError(id, -32600, "Invalid JSON-RPC request");
      return;
    }
    if (!("id" in request) || !isRequestId(request.id)) return;
    void this.handleRequest(request.id, request.method, request.params);
  }

  private async handleRequest(
    id: RequestId,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      switch (method) {
        case "initialize":
          this.sendResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "cod-runtime-context", version: "0.0.0" },
          });
          return;
        case "ping":
          this.sendResult(id, {});
          return;
        case "tools/list":
          this.sendResult(id, { tools: TOOLS });
          return;
        case "tools/call":
          await this.callTool(id, params);
          return;
        default:
          this.sendError(id, -32601, `Method not found: ${method}`);
      }
    } catch {
      this.sendError(id, -32603, "Internal server error");
    }
  }

  private async callTool(id: RequestId, params: unknown): Promise<void> {
    if (!isRecord(params) || typeof params.name !== "string") {
      this.sendError(id, -32602, "Invalid tools/call parameters");
      return;
    }
    if (params.name !== "cod_context" && params.name !== "cod_help") {
      this.sendError(id, -32602, `Unknown tool: ${params.name}`);
      return;
    }
    if (
      params.arguments !== undefined &&
      (!isRecord(params.arguments) || Object.keys(params.arguments).length > 0)
    ) {
      this.sendError(id, -32602, "Tool arguments must be an empty object");
      return;
    }

    try {
      const payload =
        params.name === "cod_context"
          ? await this.context()
          : await this.help();
      this.sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        isError: false,
      });
    } catch (error) {
      this.sendResult(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: errorMessage(error) }),
          },
        ],
        isError: true,
      });
    }
  }

  private async context(): Promise<unknown> {
    const [stateValue, capabilities] = await Promise.all([
      this.options.invoke({ op: "state" }),
      this.options.invoke({ op: "capabilities" }),
    ]);
    if (!isRecord(stateValue) || !Array.isArray(stateValue.workspaces)) {
      throw new ContextTargetError(
        "Application state did not contain the bound workspace",
      );
    }
    const conversations = Array.isArray(stateValue.conversations)
      ? stateValue.conversations
      : [];
    const conversation = conversations.find(
      (value) => isRecord(value) && value.id === this.options.conversationId,
    );
    if (!isRecord(conversation)) {
      throw new ContextTargetError(
        `Bound conversation was not found: ${this.options.conversationId}`,
      );
    }
    const workspace = stateValue.workspaces.find(
      (value) => isRecord(value) && value.id === conversation.workspaceId,
    );
    if (!isRecord(workspace)) {
      throw new ContextTargetError(
        `Conversation workspace was not found: ${String(conversation.workspaceId)}`,
      );
    }

    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        folders: workspace.folders,
        activePaneId: workspace.activePaneId,
      },
      conversation: {
        id: conversation.id,
        provider: conversation.provider,
        nativeId: conversation.nativeId,
        cwd: conversation.cwd,
        status: conversation.status,
      },
      capabilities,
      cliCommand: this.options.cliCommand,
      helpText: this.options.helpText,
      guidance: RUNTIME_GUIDANCE,
    };
  }

  private async help(): Promise<unknown> {
    const capabilities = await this.options.invoke({ op: "capabilities" });
    return {
      helpText: this.options.helpText,
      cliCommand: this.options.cliCommand,
      capabilities,
      guidance: RUNTIME_GUIDANCE,
    };
  }

  private sendResult(id: RequestId, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: RequestId, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed) return;
    this.pendingWrites += 1;
    try {
      this.output.write(`${JSON.stringify(message)}\n`, (error) => {
        this.pendingWrites -= 1;
        if (!error) this.detachOutputIfSettled();
      });
    } catch {
      this.pendingWrites -= 1;
      this.close();
    }
  }
}

export function serveRuntimeContext(
  options: RuntimeContextOptions,
): RuntimeContextHandle {
  return new RuntimeContextServer(options);
}
