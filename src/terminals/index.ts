import { accessSync, constants, statSync } from "node:fs";

const OUTPUT_LIMIT = 1024 * 1024;
const INPUT_LIMIT = 1024 * 1024;
const MAX_DIMENSION = 1000;
const HUP_GRACE_MS = 1000;
const KILL_GRACE_MS = 1000;
const TERMINAL_TYPE = "xterm-256color";

export interface PtyDisposable {
  dispose(): void;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): PtyDisposable;
}

export type PtySpawn = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    cols: number;
    rows: number;
    name: string;
    env: Record<string, string>;
  },
) => PtyProcess;

export interface TerminalCreateInput {
  id: string;
  workspaceId: string;
  cwd: string;
  cols: number;
  rows: number;
  shell?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface TerminalSnapshot {
  id: string;
  workspaceId: string;
  cwd: string;
  cols: number;
  rows: number;
  status: "running" | "exited";
  pid: number;
  output: string;
  exitCode?: number;
}

export type TerminalEvent = {
  id: string;
  workspaceId: string;
} & (
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number }
  | { type: "error"; message: string }
);

export type TerminalListener = (event: TerminalEvent) => void;

export interface TerminalServiceOptions {
  spawn: PtySpawn;
  onEvent?: TerminalListener;
}

interface TerminalRecord {
  id: string;
  workspaceId: string;
  cwd: string;
  cols: number;
  rows: number;
  status: "running" | "exited";
  pid: number;
  output: string;
  exitCode?: number;
  pty: PtyProcess;
  nativeListeners: PtyDisposable[];
  exited: Promise<void>;
  notifyExited: () => void;
  closePromise?: Promise<void>;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateId(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function validateDimensions(cols: number, rows: number): void {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > MAX_DIMENSION ||
    rows > MAX_DIMENSION
  ) {
    throw new Error(
      `Terminal dimensions must be integers between 1 and ${MAX_DIMENSION}`,
    );
  }
}

function validateDirectory(cwd: string): void {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("cwd must be a non-empty string");
  }
  try {
    if (!statSync(cwd).isDirectory()) {
      throw new Error(`Terminal cwd is not a directory: ${cwd}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Terminal cwd")) {
      throw error;
    }
    throw new Error(`Terminal cwd is not an existing directory: ${cwd}`);
  }
}

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "cmd.exe";
  }
  return process.env.SHELL || "/bin/sh";
}

export class TerminalService {
  private readonly spawn: PtySpawn;
  private onEvent?: TerminalListener;
  private readonly listeners = new Set<TerminalListener>();
  private readonly terminals = new Map<string, TerminalRecord>();
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(options: TerminalServiceOptions) {
    if (typeof options?.spawn !== "function") {
      throw new Error("TerminalService requires a PTY spawn function");
    }
    this.spawn = options.spawn;
    this.onEvent = options.onEvent;
  }

  subscribe(listener: TerminalListener): () => void {
    if (typeof listener !== "function") {
      throw new Error("Terminal listener must be a function");
    }
    if (this.disposed) {
      throw new Error("Terminal service is disposed");
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  create(input: TerminalCreateInput): TerminalSnapshot {
    this.ensureActive();
    validateId(input.id, "Terminal id");
    validateId(input.workspaceId, "Workspace id");
    if (this.terminals.has(input.id)) {
      throw new Error(`Terminal already exists: ${input.id}`);
    }
    validateDirectory(input.cwd);
    validateDimensions(input.cols, input.rows);

    const shell = input.shell ?? defaultShell();
    if (typeof shell !== "string" || shell.trim().length === 0) {
      throw new Error("Terminal shell must be a non-empty string");
    }
    if (shell.includes("/") || shell.includes("\\")) {
      try {
        if (!statSync(shell).isFile()) throw new Error("Not a file");
        accessSync(shell, constants.X_OK);
      } catch {
        throw new Error(`Terminal shell is not an executable file: ${shell}`);
      }
    }
    const args = input.args ?? [];
    if (
      !Array.isArray(args) ||
      args.some((argument) => typeof argument !== "string")
    ) {
      throw new Error("Terminal args must be an array of strings");
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.env ?? process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.TERM = input.env?.TERM ?? TERMINAL_TYPE;
    const pty = this.spawn(shell, args, {
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      name: TERMINAL_TYPE,
      env,
    });

    let notifyExited = () => {};
    const exited = new Promise<void>((resolve) => {
      notifyExited = resolve;
    });
    const record: TerminalRecord = {
      id: input.id,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      status: "running",
      pid: pty.pid,
      output: "",
      pty,
      nativeListeners: [],
      exited,
      notifyExited,
    };

    try {
      const dataListener = pty.onData((data) => {
        if (record.status === "exited") return;
        record.output = (record.output + data).slice(-OUTPUT_LIMIT);
        this.emit({
          id: record.id,
          workspaceId: record.workspaceId,
          type: "data",
          data,
        });
      });
      record.nativeListeners.push(dataListener);
      const exitListener = pty.onExit(({ exitCode }) => {
        if (record.status === "exited") return;
        record.status = "exited";
        record.exitCode = exitCode;
        record.notifyExited();
        this.detachNativeListeners(record);
        this.emit({
          id: record.id,
          workspaceId: record.workspaceId,
          type: "exit",
          exitCode,
        });
      });
      if (record.status === "exited") exitListener.dispose();
      else record.nativeListeners.push(exitListener);
      this.terminals.set(record.id, record);
      return this.snapshot(record.id);
    } catch (error) {
      this.detachNativeListeners(record);
      try {
        pty.kill("SIGHUP");
      } catch {}
      throw error;
    }
  }

  write(id: string, data: string): void {
    this.ensureActive();
    const record = this.requireTerminal(id);
    if (record.status === "exited") {
      throw new Error(`Terminal has exited: ${id}`);
    }
    if (typeof data !== "string" || data.length > INPUT_LIMIT) {
      throw new Error(
        `Terminal input must be a string of at most ${INPUT_LIMIT} characters`,
      );
    }
    try {
      record.pty.write(data);
    } catch (error) {
      this.reportError(record, error);
      throw error;
    }
  }

  resize(id: string, cols: number, rows: number): void {
    this.ensureActive();
    const record = this.requireTerminal(id);
    validateDimensions(cols, rows);
    if (record.status === "exited") {
      throw new Error(`Terminal has exited: ${id}`);
    }
    try {
      record.pty.resize(cols, rows);
      record.cols = cols;
      record.rows = rows;
    } catch (error) {
      this.reportError(record, error);
      throw error;
    }
  }

  snapshot(id: string): TerminalSnapshot {
    const record = this.requireTerminal(id);
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      cwd: record.cwd,
      cols: record.cols,
      rows: record.rows,
      status: record.status,
      pid: record.pid,
      output: record.output,
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    };
  }

  close(id: string): Promise<void> {
    this.ensureActive();
    const record = this.requireTerminal(id);
    if (!record.closePromise) {
      record.closePromise = this.closeRecord(record);
    }
    return record.closePromise;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.disposeAll();
    return this.disposePromise;
  }

  private async closeRecord(record: TerminalRecord): Promise<void> {
    if (record.status === "exited") return;
    try {
      record.pty.kill("SIGHUP");
    } catch (error) {
      this.reportError(record, error);
    }
    if (await this.waitForExit(record, HUP_GRACE_MS)) return;

    try {
      record.pty.kill("SIGKILL");
    } catch (error) {
      this.reportError(record, error);
    }
    if (!(await this.waitForExit(record, KILL_GRACE_MS))) {
      throw new Error(
        `Terminal did not exit after bounded cleanup: ${record.id}`,
      );
    }
  }

  private waitForExit(
    record: TerminalRecord,
    timeoutMs: number,
  ): Promise<boolean> {
    if (record.status === "exited") return Promise.resolve(true);
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      record.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private async disposeAll(): Promise<void> {
    const records = [...this.terminals.values()];
    const results = await Promise.allSettled(
      records.map((record) => {
        if (!record.closePromise)
          record.closePromise = this.closeRecord(record);
        return record.closePromise;
      }),
    );
    for (const record of records) this.detachNativeListeners(record);
    this.terminals.clear();
    this.listeners.clear();
    this.onEvent = undefined;
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Some terminals did not exit during disposal",
      );
    }
  }

  private detachNativeListeners(record: TerminalRecord): void {
    for (const listener of record.nativeListeners.splice(0)) {
      try {
        listener.dispose();
      } catch {}
    }
  }

  private requireTerminal(id: string): TerminalRecord {
    validateId(id, "Terminal id");
    const record = this.terminals.get(id);
    if (!record) throw new Error(`Unknown terminal: ${id}`);
    return record;
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error("Terminal service is disposed");
  }

  private reportError(record: TerminalRecord, error: unknown): void {
    this.emit({
      id: record.id,
      workspaceId: record.workspaceId,
      type: "error",
      message: messageFrom(error),
    });
  }

  private emit(event: TerminalEvent): void {
    const listeners = [
      ...(this.onEvent ? [this.onEvent] : []),
      ...this.listeners,
    ];
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {}
    }
  }
}
