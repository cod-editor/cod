import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AppState,
  WorkspaceState,
  PaneState,
  ConversationState,
  OperationRequest,
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
    pinnedSites: [],
    browserDownloads: [],
    drafts: {},
  };
  private composerCheckpoint = "initial";
  private draftOverlays: Record<
    string,
    {
      workspace: string;
      pane: string;
      draft: Omit<NonNullable<WorkspaceState["chatDrafts"]>[string], "images">;
    }
  > = {};
  private queue: Promise<unknown> = Promise.resolve();
  private pendingDrafts = new Map<
    string,
    { mutation: () => unknown | Promise<unknown>; promise: Promise<unknown> }
  >();
  private timer?: NodeJS.Timeout;
  private notificationTimer?: NodeJS.Timeout;
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
      ) as AppState & { composerCheckpoint?: string };
      if (!Array.isArray(saved.workspaces))
        throw new Error("Invalid saved state");
      this.composerCheckpoint = saved.composerCheckpoint ?? "initial";
      delete saved.composerCheckpoint;
      Object.assign(this.data, saved, {
        conversations: saved.conversations ?? [],
        drafts: saved.drafts ?? {},
        pinnedSites: saved.pinnedSites ?? [],
        browserDownloads: (saved.browserDownloads ?? []).map((item) => ({
          ...item,
          canResume: false,
          status: ["progressing", "paused"].includes(item.status)
            ? "interrupted"
            : item.status,
        })),
        terminals: saved.terminals ?? [],
        browsers: (saved.browsers ?? []).map((browser) => ({
          ...browser,
          nativeTabId: undefined,
          permissionRequests: undefined,
          addons: undefined,
          visible: false,
          loading: false,
          canGoBack: false,
          canGoForward: false,
        })),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.restoreComposerText();
  }
  private async restoreComposerText(): Promise<void> {
    try {
      const saved = JSON.parse(
        await readFile(path.join(this.directory, "composer-text.json"), "utf8"),
      );
      if (saved.checkpoint !== this.composerCheckpoint) return;
      for (const entry of Object.values(
        saved.drafts,
      ) as (typeof this.draftOverlays)[string][]) {
        const workspace = this.data.workspaces.find(
          (w) => w.id === entry.workspace,
        );
        if (
          !workspace?.panes.some((p) => p.id === entry.pane) ||
          typeof entry.draft?.text !== "string"
        )
          continue;
        workspace.chatDrafts ??= {};
        workspace.chatDrafts[entry.pane] = {
          ...entry.draft,
          ...(entry.draft.localDraft
            ? {
                localDraft: {
                  ...entry.draft.localDraft,
                  images:
                    workspace.chatDrafts[entry.pane]?.localDraft?.images ?? [],
                },
              }
            : {}),
          ...(workspace.chatDrafts[entry.pane]?.images
            ? { images: workspace.chatDrafts[entry.pane].images }
            : {}),
        };
      }
      this.draftOverlays = saved.drafts;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "Could not restore composer text; draft file retained",
          { cause: error },
        );
    }
  }
  private async commitDraft(
    mutation: () => unknown | Promise<unknown>,
  ): Promise<unknown> {
    // Only chatDrafts may change here. Keep shallow originals for rollback instead
    // of cloning histories/images for each edit.
    const before = this.data.workspaces.map((workspace) => ({
      workspace,
      drafts: workspace.chatDrafts ? { ...workspace.chatDrafts } : undefined,
    }));
    const overlays = { ...this.draftOverlays };
    try {
      const result = await mutation();
      for (const { workspace, drafts } of before) {
        for (const [pane, draft] of Object.entries(
          workspace.chatDrafts ?? {},
        )) {
          if (draft === drafts?.[pane]) continue;
          const { images: _images, localDraft, ...text } = draft;
          if (localDraft) {
            const { images: _localImages, ...localText } = localDraft;
            Object.assign(text, { localDraft: localText });
          }
          overlays[`${workspace.id}:${pane}`] = {
            workspace: workspace.id,
            pane,
            draft: text,
          };
        }
      }
      const file = path.join(this.directory, "composer-text.json");
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({
          checkpoint: this.composerCheckpoint,
          drafts: overlays,
        }),
        { mode: 0o600 },
      );
      await rename(temporary, file);
      this.draftOverlays = overlays;
      return result;
    } catch (error) {
      for (const { workspace, drafts } of before) workspace.chatDrafts = drafts;
      throw error;
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
  /** A delayed choice can only replace the blank tab the user selected. */
  openingPane(workspace: WorkspaceState, request: OperationRequest): PaneState {
    const id = request.replacePane;
    if (id !== undefined && typeof id !== "string")
      throw new Error("replacePane must be a pane ID");
    const pane =
      id === undefined
        ? this.pane(workspace, workspace.activePaneId)
        : workspace.panes.find((item) => item.id === id);
    if (!pane)
      throw new Error(
        "The blank tab was closed. Open a new tab and choose again.",
      );
    if (id !== undefined && !(pane.kind === "empty" && pane.launcher))
      throw new Error(
        "The blank tab was changed. Open a new tab and choose again.",
      );
    return pane;
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
    // Any intervening operation is an ordering barrier for draft coalescing.
    this.pendingDrafts.clear();
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  change<T>(
    mutation: () => T | Promise<T>,
    options: { notify?: boolean } = {},
  ): Promise<T> {
    return this.serialize(() => this.commitChange(mutation, options));
  }
  /** Coalesce only consecutive trusted text edits, never across another operation. */
  changeDraft(
    key: string,
    mutation: () => unknown | Promise<unknown>,
  ): Promise<unknown> {
    const pending = this.pendingDrafts.get(key);
    if (pending) {
      pending.mutation = mutation;
      return pending.promise;
    }
    const entry = { mutation, promise: Promise.resolve() as Promise<unknown> };
    entry.promise = this.serialize(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (this.pendingDrafts.get(key) === entry) this.pendingDrafts.delete(key);
      return this.commitDraft(entry.mutation);
    });
    this.pendingDrafts.set(key, entry);
    return entry.promise;
  }
  private async commitChange<T>(
    mutation: () => T | Promise<T>,
    options: { notify?: boolean },
  ): Promise<T> {
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
      if (options.notify !== false) this.notify();
      return result;
    } catch (error) {
      rollbackState(this.data, before, original);
      throw error;
    }
  }
  notify(coalesce = false): void {
    this.beforeNotify?.();
    if (!coalesce) {
      if (this.notificationTimer) clearTimeout(this.notificationTimer);
      this.notificationTimer = undefined;
      this.onDidChange?.(this.snapshot());
      return;
    }
    if (this.notificationTimer || this.closing) return;
    // Streaming events can arrive faster than the UI can consume full snapshots.
    // Snapshot the latest state once per batch, not once per token/tool event.
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = undefined;
      if (!this.closing) this.onDidChange?.(this.snapshot());
    }, 50);
    this.notificationTimer.unref();
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
    // JSON.stringify captures this shallow view synchronously before the first
    // await; a second deep clone of every transcript and image is unnecessary.
    const checkpoint = randomUUID();
    const saved = {
      ...this.data,
      composerCheckpoint: checkpoint,
      terminals: this.data.terminals.map((terminal) => ({
        ...terminal,
        status: "starting",
        pid: 0,
        output: "",
        sequence: 0,
        exitCode: undefined,
        error: undefined,
      })),
    };
    const statePath = path.join(this.directory, "state.json");
    const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
    await rename(temporary, statePath);
    this.composerCheckpoint = checkpoint;
    this.draftOverlays = {};
  }
}
