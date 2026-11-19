import { normalizeGroups } from "../workspace-layout";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawn as spawnPty } from "@homebridge/node-pty-prebuilt-multiarch";
import { TerminalService, type TerminalEvent } from "../terminals";
import type {
  TerminalState,
  TerminalUiEvent,
  WorkspaceState,
  OperationRequest,
} from "../types";
import { ApplicationStateStore } from "./state";
import { requiredString } from "./request";

export class TerminalApplicationService {
  private readonly processes: TerminalService;
  onDidTerminal?: (event: TerminalUiEvent) => void;
  constructor(private readonly store: ApplicationStateStore) {
    this.processes = new TerminalService({
      spawn: spawnPty,
      onEvent: (event) => this.terminalEvent(event),
    });
  }
  createProcess(input: Parameters<TerminalService["create"]>[0]) {
    return this.processes.create(input);
  }
  stopProcess(id: string) {
    return this.processes.close(id);
  }
  shutdown() {
    return this.processes.dispose();
  }
  async currentDirectory(id: string): Promise<string> {
    const source = this.terminal(id);
    // Restored native handoff terminals deliberately have no owned process.
    // A fresh shell still uses their recorded directory and no native command.
    if (source.status === "exited" || source.status === "failed")
      return source.cwd;
    const cwd = await this.processes.currentDirectory(id);
    this.syncTerminal(source);
    return cwd;
  }
  terminalShell(): { shell?: string; args?: string[] } {
    const shell = process.env.COD_TERMINAL_SHELL;
    const encoded = process.env.COD_TERMINAL_ARGS;
    let args: string[] | undefined;
    if (encoded) {
      try {
        const parsed = JSON.parse(encoded) as unknown;
        if (
          !Array.isArray(parsed) ||
          !parsed.every((value) => typeof value === "string")
        ) {
          throw new Error("not an array");
        }
        args = parsed;
      } catch {
        throw new Error("COD_TERMINAL_ARGS must be a JSON array of strings");
      }
    }
    return { shell, args };
  }

  restoreTerminal(terminal: TerminalState): void {
    if (terminal.nativeConversationId) {
      terminal.status = "exited";
      terminal.pid = 0;
      terminal.output =
        "Native CLI ended with the previous app instance. Return to chat to resume this session.\r\n";
      return;
    }
    try {
      const snapshot = this.processes.create({
        id: terminal.id,
        workspaceId: terminal.workspaceId,
        cwd: terminal.cwd,
        cols: terminal.cols,
        rows: terminal.rows,
        ...this.terminalShell(),
      });
      Object.assign(terminal, snapshot, { sequence: 0, error: undefined });
    } catch (error) {
      Object.assign(terminal, {
        status: "failed",
        pid: 0,
        output: "",
        sequence: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async openTerminal(
    request: OperationRequest,
  ): Promise<{ id: string; paneId: string }> {
    if (this.store.closing) throw new Error("Cod is shutting down");
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const cwd = path.resolve(
      request.cwd === undefined
        ? (workspace.folders[0] ?? os.homedir())
        : requiredString(request, "cwd"),
    );
    const target = this.store.openingPane(workspace, request);
    const id = randomUUID();
    const snapshot = this.processes.create({
      id,
      workspaceId: workspace.id,
      cwd,
      cols: 80,
      rows: 24,
      ...this.terminalShell(),
    });
    const terminal: TerminalState = { ...snapshot, paneId: "", sequence: 0 };
    if (request.sourcePane !== undefined) {
      terminal.paneId = randomUUID();
      this.store.insertPane(
        workspace,
        { id: terminal.paneId, kind: "terminal", terminalId: id },
        request,
      );
    } else terminal.paneId = this.attachTerminal(workspace, id, target);
    this.store.data.terminals.push(terminal);
    try {
      await this.store.persist();
    } catch (error) {
      await this.processes.close(id);
      this.removeTerminalRecord(terminal);
      throw error;
    }
    this.store.notify();
    return { id, paneId: terminal.paneId };
  }

  attachTerminal(
    workspace: WorkspaceState,
    terminalId: string,
    target?: import("../types").PaneState,
  ): string {
    const active = target ?? this.store.pane(workspace, workspace.activePaneId);
    if (
      (active.kind === "document" && !active.filePath && !active.draftChat) ||
      (active.kind === "empty" && active.launcher)
    ) {
      const index = workspace.panes.indexOf(active);
      workspace.panes[index] = {
        id: active.id,
        pinned: active.pinned,
        kind: "terminal",
        terminalId,
      };
      workspace.activePaneId = active.id;
      return active.id;
    }
    const paneId = randomUUID();
    workspace.panes.push({ id: paneId, kind: "terminal", terminalId });
    workspace.activePaneId = paneId;
    return paneId;
  }

  writeTerminal(request: OperationRequest): { id: string } {
    const id = requiredString(request, "id");
    const data = request.data;
    if (typeof data !== "string") throw new Error("data must be a string");
    this.processes.write(id, data);
    return { id };
  }

  async resizeTerminal(request: OperationRequest): Promise<{ id: string }> {
    const id = requiredString(request, "id");
    this.processes.resize(id, Number(request.cols), Number(request.rows));
    this.syncTerminal(this.terminal(id));
    await this.store.persist();
    this.store.notify();
    return { id };
  }

  inspectTerminal(id: string): TerminalState {
    const terminal = this.terminal(id);
    if (
      terminal.pid !== 0 &&
      (terminal.status === "running" || terminal.status === "exited")
    )
      this.syncTerminal(terminal);
    return terminal;
  }

  removeTerminalRecord(terminal: TerminalState): void {
    this.store.data.terminals = this.store.data.terminals.filter(
      (item) => item !== terminal,
    );
    const workspace = this.store.data.workspaces.find(
      (item) => item.id === terminal.workspaceId,
    );
    if (!workspace) return;
    workspace.panes = workspace.panes.filter(
      (pane) => pane.id !== terminal.paneId,
    );
    if (!workspace.panes.length) {
      const empty = {
        id: randomUUID(),
        kind: "document",
        draftChat: true,
      } as const;
      workspace.panes.push(empty);
    }
    normalizeGroups(workspace);
  }

  terminal(id: string): TerminalState {
    const terminal = this.store.data.terminals.find((item) => item.id === id);
    if (!terminal) throw new Error(`Unknown terminal: ${id}`);
    return terminal;
  }

  syncTerminal(terminal: TerminalState): void {
    Object.assign(terminal, this.processes.snapshot(terminal.id));
  }

  terminalEvent(event: TerminalEvent): void {
    const terminal = this.store.data.terminals.find(
      (item) => item.id === event.id,
    );
    if (!terminal || this.store.closing) return;
    this.syncTerminal(terminal);
    terminal.sequence += 1;
    const output: TerminalUiEvent = {
      terminalId: terminal.id,
      sequence: terminal.sequence,
      type: event.type,
      ...(event.type === "data" ? { data: event.data } : {}),
      ...(event.type === "error" ? { message: event.message } : {}),
    };
    this.onDidTerminal?.(output);
    this.store.notify();
  }

  async handle(
    request: OperationRequest,
    _trustedUi = false,
  ): Promise<unknown> {
    switch (request.op) {
      case "terminal.open":
        return this.store.serialize(() => this.openTerminal(request));

      case "terminal.write":
        return this.writeTerminal(request);

      case "terminal.resize":
        return this.store.serialize(() => this.resizeTerminal(request));

      case "terminal.inspect":
        return structuredClone(
          this.inspectTerminal(requiredString(request, "id")),
        );

      default:
        throw new Error("Unknown terminal operation");
    }
  }

  restoreAll(): void {
    for (const terminal of this.store.data.terminals)
      this.restoreTerminal(terminal);
  }
}
