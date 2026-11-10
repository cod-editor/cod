import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AppState,
  WorkspaceState,
  PaneState,
  ConversationState,
} from "../types";
import { normalizeGroups } from "../workspace-layout.ts";
import { rollbackState } from "../state-rollback.ts";

/** Single owner of application state, transaction ordering and durable snapshots. */
export class ApplicationStateStore {
  readonly data: AppState = {
    workspaces: [],
    activeWorkspaceId: null,
    conversations: [],
    terminals: [],
    browsers: [],
    drafts: {},
  };
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  closing = false;
  onDidChange?: (state: AppState) => void;
  beforeNotify?: () => void;
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(
        await readFile(path.join(this.directory, "state.json"), "utf8"),
      ) as AppState;
      if (!Array.isArray(saved.workspaces))
        throw new Error("Invalid saved state");
      Object.assign(this.data, saved, {
        conversations: saved.conversations ?? [],
        drafts: saved.drafts ?? {},
        terminals: saved.terminals ?? [],
        browsers: (saved.browsers ?? []).map((browser) => ({
          ...browser,
          nativeTabId: undefined,
          addons: undefined,
          visible: false,
          loading: false,
        })),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  snapshot(): AppState {
    this.data.workspaces.forEach(normalizeGroups);
    return structuredClone(this.data);
  }
  workspace(id: string): WorkspaceState {
    const workspace = this.data.workspaces.find((item) => item.id === id);
    if (!workspace) throw new Error(`Workspace not found: ${id}`);
    return workspace;
  }
  pane(workspace: WorkspaceState, id: string): PaneState {
    const pane = workspace.panes.find((item) => item.id === id);
    if (!pane) throw new Error(`Pane not found: ${id}`);
    return pane;
  }
  conversation(id: string): ConversationState {
    const conversation = this.data.conversations.find((item) => item.id === id);
    if (!conversation) throw new Error(`Conversation not found: ${id}`);
    return conversation;
  }
  serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  change<T>(mutation: () => T | Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const before = this.snapshot();
      const original = {
        ...this.data,
        workspaces: [...this.data.workspaces],
        conversations: [...this.data.conversations],
        browsers: [...this.data.browsers],
        terminals: [...this.data.terminals],
      };
      try {
        const result = await mutation();
        await this.persist();
        this.notify();
        return result;
      } catch (error) {
        rollbackState(this.data, before, original);
        throw error;
      }
    });
  }
  notify(): void {
    this.beforeNotify?.();
    this.onDidChange?.(this.snapshot());
  }
  schedulePersist(immediate = false): void {
    if (this.closing) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.serialize(() => this.persist()).catch((error) =>
          console.error(error),
        );
      },
      immediate ? 0 : 100,
    );
  }
  beginShutdown(): void {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  async persist(): Promise<void> {
    const saved = this.snapshot();
    saved.terminals = saved.terminals.map((terminal) => ({
      ...terminal,
      status: "starting",
      pid: 0,
      output: "",
      sequence: 0,
      exitCode: undefined,
      error: undefined,
    }));
    const statePath = path.join(this.directory, "state.json");
    const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
    await rename(temporary, statePath);
  }
}
