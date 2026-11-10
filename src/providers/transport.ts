import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AdapterOptions } from "./types.ts";

export type RpcId = string | number;
export interface RpcMessage {
  id?: RpcId;
  method: string;
  params: Record<string, unknown>;
}
export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
export const errorOf = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
/** One JSON-lines protocol, owned by one child process. Never mixes stderr into JSON. */
export class RpcTransport {
  readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private failure?: Error;
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private stderrBudget = 16_384;
  private readonly timeout: number;
  private readonly processGroup?: number;
  private readonly receive: (message: RpcMessage) => void;
  private readonly failed: (error: Error) => void;
  private readonly diagnostic: (message: string) => void;
  constructor(
    options: AdapterOptions,
    executable: string,
    args: string[],
    receive: (message: RpcMessage) => void,
    failed: (error: Error) => void,
    diagnostic: (message: string) => void,
  ) {
    this.receive = receive;
    this.failed = failed;
    this.diagnostic = diagnostic;
    this.timeout = options.requestTimeoutMs ?? 30_000;
    this.child = spawn(options.executable ?? executable, options.args ?? args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      // POSIX detached spawn creates a fresh session/process group, not an
      // unattended runner: pipes remain attached and close owns group cleanup.
      detached: process.platform !== "win32",
    });
    if (
      process.platform !== "win32" &&
      this.child.pid &&
      this.child.pid > 1 &&
      this.child.pid !== process.pid
    ) {
      this.processGroup = this.child.pid;
    }
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.closing || this.failure) return;
      this.buffer += this.decoder.write(chunk);
      let end: number;
      while ((end = this.buffer.indexOf("\n")) !== -1) {
        if (end > 4 * 1024 * 1024) {
          this.fail(new Error("Provider protocol line exceeded size limit"));
          return;
        }
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (line) this.read(line);
        if (this.failure) return;
      }
      if (this.buffer.length > 4 * 1024 * 1024)
        this.fail(new Error("Provider protocol line exceeded size limit"));
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (this.stderrBudget <= 0) return;
      const value = chunk.toString("utf8").slice(0, this.stderrBudget);
      this.stderrBudget -= value.length;
      this.diagnostic(value);
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      if (!this.closing)
        this.fail(
          new Error(`Provider process exited (${signal ?? code ?? "unknown"})`),
        );
    });
  }
  private read(line: string) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.fail(new Error("Malformed provider protocol JSON"));
      return;
    }
    const message = object(value);
    if (!Object.keys(message).length) {
      this.fail(new Error("Invalid provider protocol frame"));
      return;
    }
    if (typeof message.method === "string") {
      if (
        message.id !== undefined &&
        typeof message.id !== "number" &&
        typeof message.id !== "string"
      ) {
        this.fail(new Error("Invalid provider request identifier"));
        return;
      }
      this.receive({
        id: message.id as RpcId | undefined,
        method: message.method,
        params: object(message.params),
      });
      return;
    }
    // A response can only settle an outstanding request from this exact transport.
    const pending =
      typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!pending) {
      this.diagnostic("Ignored unmatched provider response");
      return;
    }
    this.pending.delete(message.id as number);
    clearTimeout(pending.timer);
    if ("error" in message)
      pending.reject(
        new Error(
          string(object(message.error).message) ?? "Provider RPC error",
        ),
      );
    else if ("result" in message) pending.resolve(message.result);
    else
      pending.reject(new Error("Provider response omitted result and error"));
  }
  private fail(error: Error) {
    if (this.failure || this.closing) return;
    this.failure = error;
    this.rejectPending(error);
    this.failed(error);
    if (!this.closed) void this.close();
  }
  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  private write(message: unknown) {
    if (this.closing || this.closed || this.failure)
      throw this.failure ?? new Error("Provider controller is closed");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  notify(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }
  respond(id: RpcId, result: unknown) {
    this.write({ jsonrpc: "2.0", id, result });
  }
  reject(id: RpcId, code: number, message: string) {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }
  request(
    method: string,
    params: unknown,
    timeout = this.timeout,
  ): Promise<unknown> {
    if (this.closing || this.closed || this.failure)
      return Promise.reject(
        this.failure ?? new Error("Provider controller is closed"),
      );
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Provider request timed out: ${method}`);
        reject(error);
        // A timed-out mutation has an unknown outcome: do not reuse its controller.
        this.fail(error);
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(errorOf(error));
      }
    });
  }
  private groupAlive(): boolean {
    if (!this.processGroup) return false;
    try {
      process.kill(-this.processGroup, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  private signalOwned(signal: NodeJS.Signals): void {
    if (!this.processGroup) {
      this.child.kill(signal);
      return;
    }
    // Only the PGID returned for our detached spawn is ever targeted.
    try {
      process.kill(-this.processGroup, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        this.diagnostic(
          `Unable to signal owned provider process group: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
        );
      }
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.rejectPending(new Error("Provider controller is closed"));
    this.closePromise = new Promise((resolve) => {
      const leaderExited = () =>
        this.closed ||
        this.child.exitCode !== null ||
        this.child.signalCode !== null ||
        !this.child.pid;
      if (leaderExited() && !this.groupAlive()) {
        resolve();
        return;
      }
      let escalated = false;
      const finish = () => {
        if (!leaderExited() || (!escalated && this.groupAlive())) return;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.signalOwned("SIGKILL");
        escalated = true;
        finish();
      }, 1_000);
      // Keep escalation armed if the leader exits but a tool still lives.
      this.child.once("exit", finish);
      this.child.stdin.end();
      this.signalOwned("SIGTERM");
      finish();
    });
    return this.closePromise;
  }
}
