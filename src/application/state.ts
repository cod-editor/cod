import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  AppState,
  WorkspaceState,
  PaneState,
  ConversationState,
  OperationRequest,
} from "../types";
import {
  assertWorkspaceLayout,
  normalizeGroups,
  revealSplit,
  selectGroup,
} from "../workspace-layout.ts";
import { rollbackState } from "../state-rollback.ts";
import { requiredString } from "./request.ts";
import { WorkspaceDatabase } from "./sqlite-state.ts";
import {
  archiveSummary,
  workspacePaneRowId,
  chatDraftRows,
  workspaceLayout,
  workspaceRows,
  workspaceState,
  type ArchivedWorkspace,
  type ClosedTab,
  type WorkspaceRow,
} from "./sqlite-state-rows.ts";

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
    transferredCodexSessions: [],
    pendingCodexImports: {},
    completedCodexImports: {},
  };
  private readonly database: WorkspaceDatabase;
  private readonly unloadedArchives = new WeakSet<ArchivedWorkspace>();
  private queue: Promise<unknown> = Promise.resolve();
  private pendingDrafts = new Map<
    string,
    { mutation: () => unknown | Promise<unknown>; promise: Promise<unknown> }
  >();
  private timer?: NodeJS.Timeout;
  private conversationCheckpoint?: NodeJS.Timeout;
  private pendingConversations = new Set<string>();
  private notificationTimer?: NodeJS.Timeout;
  private reviewPresentation?: AppState["reviewPresentation"];
  closing = false;
  onDidChange?: (state: AppState) => void;
  beforeNotify?: () => void;
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    this.database = new WorkspaceDatabase(directory);
  }
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const saved = workspaceState(
      await this.database.request<WorkspaceRow[]>({ operation: "load" }),
    );
    saved.workspaces?.forEach(assertWorkspaceLayout);
    // A crash during upload cannot have started a host import. Only a transfer
    // that reached the commit request can keep the source fenced on restart.
    for (const chat of saved.conversations ?? [])
      if (chat.transfer?.committing === false) delete chat.transfer;
    for (const archive of saved.closedWorkspaces ?? [])
      this.unloadedArchives.add(archive);
    Object.assign(this.data, saved, {
      browserDownloads: (saved.browserDownloads ?? []).map((item) => ({
        ...item,
        canResume: false,
        status: ["progressing", "paused"].includes(item.status)
          ? "interrupted"
          : item.status,
      })),
      browsers: (saved.browsers ?? []).map((browser) => ({
        ...browser,
        nativeTabId: undefined,
        httpFallback: undefined,
        certificateOffer: undefined,
        temporaryCertificate: undefined,
        temporaryNavigationBlocked: undefined,
        permissionRequests: undefined,
        addons: undefined,
        visible: false,
        loading: false,
        canGoBack: false,
        canGoForward: false,
      })),
    });
  }

  private async readArchive(
    record: ArchivedWorkspace,
  ): Promise<ArchivedWorkspace> {
    if (!this.unloadedArchives.has(record)) return structuredClone(record);
    const archive = await this.database.request<ArchivedWorkspace | undefined>({
      operation: "read",
      kind: "archive",
      id: record.workspace.id,
    });
    if (!archive) throw new Error("Workspace archive is missing");
    return archive;
  }

  async closedTab(workspaceId: string, tab: ClosedTab): Promise<ClosedTab> {
    if (tab.pane.kind !== "conversation" || tab.conversation) return tab;
    const conversation = await this.database.request<
      ConversationState | undefined
    >({
      operation: "read",
      kind: "closed-chat",
      id: workspacePaneRowId(workspaceId, tab.pane.id),
    });
    return conversation ? { ...tab, conversation } : tab;
  }

  async workspaceWithClosedChats(
    workspace: WorkspaceState,
  ): Promise<WorkspaceState> {
    if (!workspace.closedTabs?.some(({ pane }) => pane.kind === "conversation"))
      return workspace;
    return {
      ...workspace,
      closedTabs: await Promise.all(
        workspace.closedTabs.map((tab) => this.closedTab(workspace.id, tab)),
      ),
    };
  }

  async archivedWorkspace(id?: string): Promise<ArchivedWorkspace | undefined> {
    const archive =
      id === undefined
        ? this.data.closedWorkspaces?.at(-1)
        : this.data.closedWorkspaces?.find(
            ({ workspace }) => workspace.id === id,
          );
    return archive && this.readArchive(archive);
  }

  async fullSnapshot(): Promise<AppState> {
    return this.serialize(async () => {
      const state = this.snapshot();
      const [workspaces, archives] = await Promise.all([
        Promise.all(
          state.workspaces.map((workspace) =>
            this.workspaceWithClosedChats(workspace),
          ),
        ),
        Promise.all(
          (this.data.closedWorkspaces ?? []).map((archive) =>
            this.readArchive(archive),
          ),
        ),
      ]);
      return { ...state, workspaces, closedWorkspaces: archives };
    });
  }

  private async commitDraft(
    mutation: () => unknown | Promise<unknown>,
  ): Promise<unknown> {
    // Draft edits replace the draft value. The current layout and large
    // attachments are shared with rollback until the write succeeds.
    const before = this.data.workspaces.map((workspace) => ({
      workspace,
      drafts: workspace.chatDrafts ? { ...workspace.chatDrafts } : undefined,
    }));
    try {
      const result = await mutation();
      const rows: WorkspaceRow[] = [];
      for (const { workspace, drafts } of before) {
        const current = workspace.chatDrafts ?? {};
        for (const pane of new Set([
          ...Object.keys(drafts ?? {}),
          ...Object.keys(current),
        ])) {
          if (current[pane] === drafts?.[pane]) continue;
          rows.push(
            ...chatDraftRows(
              workspacePaneRowId(workspace.id, pane),
              current[pane],
              drafts?.[pane],
            ),
          );
        }
      }
      if (rows.length)
        await this.database.request({
          operation: "save",
          scope: "partial",
          rows,
        });
      return result;
    } catch (error) {
      for (const { workspace, drafts } of before) workspace.chatDrafts = drafts;
      throw error;
    }
  }
  snapshot(visibleConversationsOnly = false): AppState {
    this.data.workspaces.forEach(normalizeGroups);
    if (!visibleConversationsOnly) return structuredClone(this.data);
    const workspace = this.data.workspaces.find(
      (item) => item.id === this.data.activeWorkspaceId,
    );
    const visiblePanes = new Set(
      workspace?.groups
        ?.filter((group) => !group.hidden)
        .map((group) => group.activePaneId),
    );
    return structuredClone({
      ...this.data,
      pendingCodexImports: undefined,
      completedCodexImports: undefined,
      transferredCodexSessions: undefined,
      reviewPresentation: this.reviewPresentation,
      // Editors read their resource through file.read; unrelated navigation does
      // not need every open or recoverable file buffer's text.
      drafts: {},
      conversations: this.data.conversations.map((conversation) => {
        if (
          conversation.workspaceId === workspace?.id &&
          visiblePanes.has(conversation.paneId)
        )
          return conversation;
        // Hidden tabs need their label and attention state, not their complete
        // transcript, tool output or image payload on every navigation update.
        const first = conversation.messages.find(
          (message) => message.role === "user",
        );
        return {
          ...conversation,
          messages: first
            ? [
                {
                  ...first,
                  images: first.images?.map((image) => ({
                    ...image,
                    data: "",
                  })),
                },
              ]
            : [],
          tools: [],
          turns: undefined,
          backgroundActivities: conversation.backgroundActivities?.map(
            ({ result: _result, ...item }) => item,
          ),
          metadata: undefined,
        };
      }),
      // Closed workspaces are restored by an operation; the renderer only needs
      // their identity for the reopen menu.
      closedWorkspaces: this.data.closedWorkspaces?.map(archiveSummary),
    });
  }
  workspace(id: string): WorkspaceState {
    const workspace = this.data.workspaces.find((item) => item.id === id);
    if (!workspace) throw new Error(`Workspace not found: ${id}`);
    return workspace;
  }
  /** Resolve a stable source, or replace only the blank tab the user selected. */
  openingPane(workspace: WorkspaceState, request: OperationRequest): PaneState {
    if (
      request.focus !== undefined &&
      ![true, false, "true", "false"].includes(request.focus as boolean)
    )
      throw new Error("focus must be true or false");
    if (request.replacePane !== undefined && request.sourcePane !== undefined)
      throw new Error("Choose replacePane or sourcePane, not both");
    const id = request.replacePane ?? request.sourcePane;
    if (id !== undefined && typeof id !== "string")
      throw new Error("replacePane must be a pane ID");
    const pane =
      id === undefined
        ? this.pane(workspace, workspace.activePaneId)
        : workspace.panes.find((item) => item.id === id);
    if (!pane)
      throw new Error(
        request.sourcePane !== undefined
          ? "The source tab was closed. Choose a tab in the target pane again."
          : "The blank tab was closed. Open a new tab and choose again.",
      );
    if (
      request.replacePane !== undefined &&
      !(pane.kind === "empty" && pane.launcher)
    )
      throw new Error(
        "The blank tab was changed. Open a new tab and choose again.",
      );
    if (request.sourcePane !== undefined) {
      normalizeGroups(workspace);
      const owner = workspace.groups!.find((group) =>
        group.paneIds.includes(pane.id),
      );
      if (!owner || (request.group !== undefined && request.group !== owner.id))
        throw new Error(
          "The source tab moved. Choose a tab in the target pane again.",
        );
    }
    return pane;
  }

  /** Append a fresh tab to its stable source group. */
  insertPane(
    workspace: WorkspaceState,
    pane: PaneState,
    request: OperationRequest,
  ): void {
    if (
      request.focus !== undefined &&
      ![true, false, "true", "false"].includes(request.focus as boolean)
    )
      throw new Error("focus must be true or false");
    normalizeGroups(workspace);
    const group =
      request.group === undefined
        ? workspace.groups!.find((item) =>
            item.paneIds.includes(
              String(request.sourcePane ?? workspace.activePaneId),
            ),
          )
        : workspace.groups!.find((item) => item.id === request.group);
    if (!group) throw new Error("Target group not found");
    const sourceId =
      request.sourcePane === undefined
        ? group.activePaneId
        : requiredString(request, "sourcePane");
    if (!group.paneIds.includes(sourceId))
      throw new Error("The source tab closed or moved");
    if (workspace.panes.some((item) => item.id === pane.id))
      throw new Error("Tab already exists");
    workspace.panes.push(pane);
    group.paneIds.push(pane.id);
    if (request.focus === true || request.focus === "true") {
      group.activePaneId = pane.id;
      selectGroup(workspace, group);
    }
  }
  /** Present material relative to its chat, independent of the active workspace view. */
  presentBesideConversation(
    workspace: WorkspaceState,
    request: OperationRequest,
    pane: PaneState,
  ): void {
    if (
      [request.group, request.sourcePane, request.replacePane].some(
        (value) => value !== undefined,
      )
    )
      throw new Error("Choose a conversation or an explicit tab destination");
    if (
      request.focus !== undefined &&
      ![true, false, "true", "false"].includes(request.focus as boolean)
    )
      throw new Error("focus must be true or false");
    const conversation = this.conversation(
      requiredString(request, "besideConversation"),
    );
    const source = workspace.groups.find((group) =>
      group.paneIds.includes(conversation.paneId),
    );
    if (conversation.workspaceId !== workspace.id || !source)
      throw new Error(
        "The source conversation has no open tab in this workspace",
      );

    const focus = request.focus === true || request.focus === "true";
    // Moving an already active file in the background would move focus too.
    if (
      !focus &&
      workspace.activePaneId === pane.id &&
      source.id === workspace.activeGroupId
    )
      return;
    revealSplit(workspace);
    const destination = workspace.groups.find((group) => group !== source)!;
    if (!destination.paneIds.includes(pane.id)) {
      const previous = workspace.groups.find((group) =>
        group.paneIds.includes(pane.id),
      );
      if (previous)
        previous.paneIds = previous.paneIds.filter((id) => id !== pane.id);
      else workspace.panes.push(pane);
      destination.paneIds.push(pane.id);
    }
    if (focus || workspace.activeGroupId !== destination.id)
      destination.activePaneId = pane.id;
    if (focus) selectGroup(workspace, destination);
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
  /** A change confined to open workspace layout cannot mutate closed archives. */
  changeLayout<T>(mutation: () => T): Promise<T> {
    return this.serialize(() => this.commitChange(mutation, {}, true));
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
    layoutOnly = false,
  ): Promise<T> {
    this.data.workspaces.forEach(normalizeGroups);
    // rollbackState deliberately preserves live provider fields. Copying those
    // transcripts here cannot help rollback and multiplies allocation on every
    // unrelated pane, browser or workspace mutation.
    const before: AppState = structuredClone({
      ...this.data,
      workspaces: layoutOnly
        ? this.data.workspaces.map(workspaceLayout)
        : this.data.workspaces,
      closedWorkspaces: undefined,
      drafts: layoutOnly ? {} : this.data.drafts,
      terminals: this.data.terminals.map((terminal) => ({
        ...terminal,
        output: "",
      })),
      conversations: this.data.conversations.map((conversation) => ({
        ...conversation,
        messages: [],
        tools: [],
        turns: undefined,
        backgroundActivities: undefined,
        metadata: undefined,
      })),
    });
    // Archive mutations replace the record. Copy only the list so rollback
    // retains unloaded summaries rather than materializing archived payloads.
    before.closedWorkspaces = this.data.closedWorkspaces?.slice();
    if (layoutOnly) {
      before.drafts = this.data.drafts;
      before.workspaces.forEach((workspace, index) => {
        workspace.chatDrafts = this.data.workspaces[index]?.chatDrafts;
        workspace.closedTabs = this.data.workspaces[index]?.closedTabs;
      });
    }
    const original = {
      ...this.data,
      workspaces: [...this.data.workspaces],
      conversations: [...this.data.conversations],
      browsers: [...this.data.browsers],
      terminals: [...this.data.terminals],
    };
    const notify = options.notify !== false;
    try {
      const result = await mutation();
      // Display layout selections while the existing checkpoint is saved.
      // The operation and subsequent mutations still wait for that checkpoint.
      if (notify && layoutOnly) this.notify();
      await this.persist(layoutOnly ? "layout" : "all");
      if (notify && !layoutOnly) this.notify();
      return result;
    } catch (error) {
      rollbackState(this.data, before, original);
      // Native events can expose an in-flight mutation while persistence waits.
      // Publish the restored model too, so observers cannot keep a phantom tab/path.
      if (notify) this.notify();
      throw error;
    }
  }
  presentReview(paneId: string): void {
    this.reviewPresentation = { paneId, token: randomUUID() };
    this.notify();
  }
  notify(coalesce = false): void {
    this.beforeNotify?.();
    if (!coalesce) {
      if (this.notificationTimer) clearTimeout(this.notificationTimer);
      this.notificationTimer = undefined;
      this.onDidChange?.(this.snapshot(true));
      return;
    }
    if (this.notificationTimer || this.closing) return;
    // Streaming events can arrive faster than the UI can consume full snapshots.
    // Snapshot the latest state once per batch, not once per token/tool event.
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = undefined;
      if (!this.closing) this.onDidChange?.(this.snapshot(true));
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
  scheduleConversationCheckpoint(id: string): void {
    this.pendingConversations.add(id);
    this.armConversationCheckpoint();
  }
  private armConversationCheckpoint(): void {
    if (this.closing || this.conversationCheckpoint) return;
    // Use one deadline for all changed chats, even as deltas keep arriving.
    const checkpoint = setTimeout(() => {
      void this.serialize(() => {
        if (this.conversationCheckpoint !== checkpoint) return;
        this.conversationCheckpoint = undefined;
        return this.persist("conversation");
      }).catch((error) => console.error(error));
    }, 2_000);
    this.conversationCheckpoint = checkpoint;
  }
  private cancelConversationCheckpoint(): void {
    if (this.conversationCheckpoint) clearTimeout(this.conversationCheckpoint);
    this.conversationCheckpoint = undefined;
  }
  beginShutdown(): void {
    this.closing = true;
    this.cancelConversationCheckpoint();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  async persist(
    scope: "all" | "layout" | "conversation" = "all",
  ): Promise<void> {
    const captured =
      scope === "layout" ? new Set<string>() : this.pendingConversations;
    if (scope !== "layout") {
      this.pendingConversations = new Set();
      this.cancelConversationCheckpoint();
    }
    try {
      if (scope === "conversation") {
        const rows = this.data.conversations.flatMap(
          (conversation, position) =>
            captured.has(conversation.id)
              ? [
                  {
                    kind: "conversation",
                    id: conversation.id,
                    position,
                    body: conversation,
                  },
                ]
              : [],
        );
        if (rows.length)
          await this.database.request({
            operation: "save",
            scope: "partial",
            rows,
          });
        return;
      }
      await this.saveWorkspace(scope);
    } catch (error) {
      for (const id of captured) this.scheduleConversationCheckpoint(id);
      throw error;
    }
  }
  private async saveWorkspace(scope: "all" | "layout"): Promise<void> {
    const pendingArchives =
      scope === "all"
        ? (this.data.closedWorkspaces?.filter(
            (archive) => !this.unloadedArchives.has(archive),
          ) ?? [])
        : [];
    const rows = workspaceRows(
      scope === "layout"
        ? this.data
        : {
            ...this.data,
            terminals: this.data.terminals.map((terminal) => ({
              ...terminal,
              status: "starting",
              pid: 0,
              output: "",
              sequence: 0,
              exitCode: undefined,
              error: undefined,
            })),
          },
      scope,
    );
    for (const archive of pendingArchives)
      rows.push({
        kind: "archive",
        id: archive.workspace.id,
        position: 0,
        body: archive,
      });
    await this.database.request({ operation: "save", scope, rows });
    if (scope === "layout") return;
    for (const workspace of this.data.workspaces)
      for (const tab of workspace.closedTabs ?? []) delete tab.conversation;
    if (pendingArchives.length)
      this.data.closedWorkspaces = this.data.closedWorkspaces?.map(
        (archive) => {
          if (!pendingArchives.includes(archive)) return archive;
          const summary = archiveSummary(archive);
          this.unloadedArchives.add(summary);
          return summary;
        },
      );
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}
