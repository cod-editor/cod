import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ChatApp } from "../e2e/helpers/chat-fixture/harness";

export interface ContextRecord {
  event: string;
  provider: string;
  method?: string;
  params?: Record<string, unknown>;
  descriptor?: {
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  } | null;
  providerNodeMode?: string | null;
  childPid?: number;
  tools?: string[];
}
export class RuntimeApp extends ChatApp {
  async prepare() {
    await super.prepare();
    this.environment.INVENTED_PRIVATE_ENV = "PRIVATE_ENV_SENTINEL";
    delete this.environment.ELECTRON_RUN_AS_NODE;
    for (const provider of ["codex", "kimi"] as const) {
      this.environment[`COD_${provider.toUpperCase()}_ARGS`] = JSON.stringify([
        path.join(this.root, "tests/runtime-integration/context-provider.mjs"),
        provider,
        this.recording,
      ]);
    }
  }
  async contextRecords(): Promise<ContextRecord[]> {
    return (await readFile(this.recording, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}
interface RpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    tools?: Array<{ name: string }>;
    protocolVersion?: string;
  };
  error?: { code: number; message: string };
}
export class ContextClient {
  child: ChildProcessWithoutNullStreams;
  private messages: RpcResponse[] = [];
  private invalid: string[] = [];
  private sequence = 0;
  private buffer = "";
  private stderr = "";
  private exited: Promise<number | null>;
  constructor(app: ChatApp, workspace: string, conversation: string) {
    this.child = spawn(
      process.execPath,
      [
        path.join(app.root, "dist/cli.cjs"),
        "context-server",
        "--workspace",
        workspace,
        "--conversation",
        conversation,
      ],
      { cwd: app.root, env: app.environment, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdin.on("error", () => {});
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      while (this.buffer.includes("\n")) {
        const end = this.buffer.indexOf("\n"),
          line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          this.messages.push(JSON.parse(line));
        } catch {
          this.invalid.push(line);
        }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk));
    this.exited = new Promise((resolve) => this.child.once("exit", resolve));
  }
  async request(method: string, params?: unknown): Promise<RpcResponse> {
    const id = ++this.sequence;
    this.child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }) + "\n",
    );
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const response = this.messages.find((message) => message.id === id);
      if (response) {
        if (response.jsonrpc !== "2.0") throw Error("Non-RPC response");
        return response;
      }
      if (this.invalid.length) throw Error("Non-protocol stdout");
      if (this.child.exitCode !== null || this.child.signalCode !== null)
        throw Error(`Context CLI exited: ${this.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error(`Context CLI response timed out: ${method}`);
  }
  async initialize() {
    const response = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "cod-qa", version: "1" },
    });
    if (response.error) throw Error(response.error.message);
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    return response;
  }
  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 1500);
    const code = await this.exited;
    clearTimeout(timer);
    if (code !== 0) throw Error(`Context CLI exit ${code}: ${this.stderr}`);
    if (this.invalid.length || this.buffer)
      throw Error("Invalid/partial protocol stdout");
  }
  async cleanup() {
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill("SIGTERM");
    await this.exited;
  }
}
export function toolPayload(response: RpcResponse): Record<string, unknown> {
  if (response.error || response.result?.isError)
    throw Error(JSON.stringify(response));
  return JSON.parse(
    response.result?.content
      ?.filter((row) => row.type === "text")
      .map((row) => row.text)
      .join("") ?? "null",
  );
}
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
