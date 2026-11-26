import { tabInsertionIndex } from "../tab-order";
import {
  acknowledgeConversation,
  backgroundWithUnknownState,
  conversationRemovalReason,
  hasRunningBackground,
} from "../conversation-actions";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { BrowserState, OperationRequest, WorkspaceState } from "../types";
import {
  assertWorkspaceLayout,
  groupLeaf,
  normalizeGroups,
  orderedGroups,
  revealSplit,
  selectGroup,
  showGroupOnly,
  tabGroup,
} from "../workspace-layout";
import { ApplicationStateStore } from "./state";
import { documentKey } from "../text-document";
import { requiredString, requiredName, providerId, object } from "./request";
import { workspacePreparation } from "./workspace-preparation";
import type { ConversationApplicationService } from "./conversation-service";
import type { BrowserApplicationService } from "./browser-service";
import type { TerminalApplicationService } from "./terminal-service";
import type { ReviewApplicationService } from "./review-service";

type BrowserHost = Pick<
  BrowserApplicationService,
  | "browser"
  | "removeBrowser"
  | "requestClose"
  | "loadAgentPage"
  | "restoreBrowser"
  | "withReopenedBrowser"
>;

async function directory(folder: string): Promise<string> {
  const resolved = path.resolve(folder);
  if (!(await stat(resolved)).isDirectory())
    throw new Error("Folder path is not a directory");
  return resolved;
}

export class WorkspaceApplicationService {
  constructor(
    private readonly store: ApplicationStateStore,
    private readonly conversations: Pick<
      ConversationApplicationService,
      "disposeController" | "isActive" | "reserve" | "release"
    >,
    private readonly browserHost: BrowserHost | undefined,
    private readonly terminals: Pick<
      TerminalApplicationService,
      | "terminal"
      | "stopProcess"
      | "restoreTerminal"
      | "openTerminal"
      | "closeQuickTerminal"
      | "quickTerminalSummaries"
    >,
    private readonly reviews: Pick<
      ReviewApplicationService,
      "list" | "relocateOrigin" | "reconcileOrigins"
    >,
  ) {}
  private get browsers(): BrowserHost {
    if (!this.browserHost)
      throw new Error("Browser operations require the desktop client");
    return this.browserHost;
  }

  createWorkspace(name: string): { id: string } {
    const id = randomUUID();
    const pane = {
      id: randomUUID(),
      kind: "document",
      draftChat: true,
    } as const;
    const group = tabGroup(pane);
    this.store.data.workspaces.push({
      id,
      name,
      folders: [],
      panes: [pane],
      activePaneId: pane.id,
      groups: [group],
      groupLayout: groupLeaf(group.id),
      activeGroupId: group.id,
    });
    this.store.data.activeWorkspaceId = id;
    return { id };
  }

  async closeWorkspace(id: string): Promise<{ id: string; closed?: boolean }> {
    const index = this.store.data.workspaces.findIndex(
      (item) => item.id === id,
    );
    if (index < 0) throw new Error(`Workspace not found: ${id}`);
    if (
      this.store.data.conversations.some(
        (chat) => chat.workspaceId === id && chat.transfer,
      )
    )
      throw new Error(
        "Resolve the pending move to Linux before closing this workspace",
      );
    const archived = structuredClone({
      workspace: await this.store.workspaceWithClosedChats(
        this.store.data.workspaces[index]!,
      ),
      conversations: this.store.data.conversations.filter(
        (item) => item.workspaceId === id,
      ),
      terminals: this.store.data.terminals.filter(
        (item) => item.workspaceId === id,
      ),
      browsers: this.store.data.browsers.filter(
        (item) => item.workspaceId === id,
      ),
    });
    // Ask pages before stopping agents or shells. Earlier pages explicitly
    // discarded by the user remain closed (and individually reopenable) if a
    // later page cancels the workspace close.
    for (const browser of this.store.data.browsers.filter(
      (item) => item.workspaceId === id,
    )) {
      const result = await this.closePane(
        {
          op: "pane.close",
          workspace: id,
          id: browser.paneId,
          includePinned: true,
        },
        { collapseSplit: false },
      );
      if (result.closed === false) return { id, closed: false };
    }
    await this.terminals.closeQuickTerminal(id);
    for (const conversation of archived.conversations)
      delete conversation.detachedOwner;
    this.store.data.closedWorkspaces ??= [];
    this.store.data.closedWorkspaces.push(archived);
    for (const conversation of this.store.data.conversations.filter(
      (item) => item.workspaceId === id,
    )) {
      await this.conversations.disposeController(conversation.id);
    }
    this.store.data.conversations = this.store.data.conversations.filter(
      (item) => item.workspaceId !== id,
    );
    for (const terminal of this.store.data.terminals.filter(
      (item) => item.workspaceId === id,
    )) {
      if (terminal.status !== "failed" && terminal.pid !== 0)
        await this.terminals.stopProcess(terminal.id);
    }
    this.store.data.terminals = this.store.data.terminals.filter(
      (item) => item.workspaceId !== id,
    );
    for (const browser of this.store.data.browsers.filter(
      (item) => item.workspaceId === id,
    ))
      this.browsers.removeBrowser(browser);
    this.store.data.workspaces.splice(index, 1);
    if (this.store.data.activeWorkspaceId === id) {
      this.store.data.activeWorkspaceId =
        this.store.data.workspaces[
          Math.min(index, this.store.data.workspaces.length - 1)
        ]?.id ?? null;
    }
    return { id };
  }

  async reopenWorkspace(
    request: OperationRequest,
    trustedUi: boolean,
  ): Promise<{ id: string }> {
    const record = await this.store.change(async () => {
      const record = await this.store.archivedWorkspace(
        typeof request.id === "string" ? request.id : undefined,
      );
      if (!record) throw new Error("No closed workspace to reopen");
      if (trustedUi && record.terminals.length && request.newShell !== true)
        throw new Error("Confirm reopening the workspace with new shells");
      assertWorkspaceLayout(record.workspace);
      if (
        record.conversations.some((saved) =>
          this.store.data.conversations.some(
            (active) =>
              active.provider === saved.provider &&
              active.nativeId === saved.nativeId,
          ),
        )
      )
        throw new Error(
          "A native session from this workspace is already controlled elsewhere",
        );
      this.store.data.closedWorkspaces =
        this.store.data.closedWorkspaces!.filter(
          (item) => item.workspace.id !== record.workspace.id,
        );
      this.store.data.workspaces.push(record.workspace);
      for (const conversation of record.conversations) {
        conversation.status = "ready";
        conversation.backgroundActivities =
          backgroundWithUnknownState(conversation);
        conversation.pendingPermissions = [];
        conversation.error = undefined;
        this.store.data.conversations.push(conversation);
      }
      // Exited PTYs retain their IDs in the terminal service. Reopening
      // starts new shells in the saved panes, with fresh process records.
      for (const pane of record.workspace.panes) {
        if (pane.kind !== "terminal") continue;
        const terminal = record.terminals.find(
          (item) => item.id === pane.terminalId,
        );
        if (!terminal || terminal.nativeConversationId) continue;
        pane.terminalId = randomUUID();
        Object.assign(terminal, {
          id: pane.terminalId,
          status: "starting",
          pid: 0,
          output: "",
          sequence: 0,
          exitCode: undefined,
          error: undefined,
        });
      }
      this.store.data.terminals.push(...record.terminals);
      this.store.data.browsers.push(
        ...record.browsers.map((browser) => ({
          ...browser,
          visible: false,
          loading: false,
        })),
      );
      this.store.data.activeWorkspaceId = record.workspace.id;
      return record;
    });
    for (const terminal of record.terminals)
      this.terminals.restoreTerminal(terminal);
    for (const browser of this.store.data.browsers.filter(
      (item) => item.workspaceId === record.workspace.id,
    )) {
      try {
        if (browser.agentPage) await this.browsers.loadAgentPage(browser);
        else await this.browsers.restoreBrowser(browser);
      } catch (error) {
        browser.error = String(error);
      }
    }
    this.store.notify();
    this.store.schedulePersist(true);
    return { id: record.workspace.id };
  }

  groupOperation(request: OperationRequest): unknown {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    normalizeGroups(workspace);
    if (request.op === "group.toggle-split") {
      const active = workspace.groups.find(
        (group) => group.id === workspace.activeGroupId,
      )!;
      if (
        workspace.groups.length === 1 ||
        workspace.groups.some((group) => group.hidden)
      )
        revealSplit(workspace);
      else showGroupOnly(workspace, active);
      return { paneId: active.activePaneId };
    }
    const id = requiredString(request, "id");
    if (request.op === "pane.move") {
      this.store.pane(workspace, id);
      const target = workspace.groups!.find(
        (group) => group.id === requiredString(request, "group"),
      );
      if (!target) throw new Error("Target group not found");
      const remaining = target.paneIds.filter((pane) => pane !== id);
      const index =
        request.index === undefined ? remaining.length : request.index;
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > remaining.length
      )
        throw new Error("Tab index must be within the destination group");
      for (const group of workspace.groups!)
        group.paneIds = group.paneIds.filter((pane) => pane !== id);
      target.paneIds.splice(
        tabInsertionIndex(workspace, remaining, id, index),
        0,
        id,
      );
      target.activePaneId = id;
      selectGroup(workspace, target);
      return { paneId: id, groupId: target.id };
    }
    const group = workspace.groups!.find((item) => item.id === id);
    if (!group) throw new Error("Group not found");
    if (request.op === "group.split")
      return this.splitGroup(workspace, group.id, request);
    if (request.op === "group.visibility") {
      const hidden =
        typeof request.hidden === "boolean" ? request.hidden : !group.hidden;
      if (hidden) {
        const other = workspace.groups.find((item) => item !== group);
        if (!other) throw new Error("At least one group must remain visible");
        showGroupOnly(workspace, other);
      } else {
        revealSplit(workspace);
      }
    } else if (request.op === "group.resize") {
      this.resizeGroup(workspace, request.ratio);
    } else {
      selectGroup(workspace, group);
    }
    return { groupId: id };
  }

  private splitGroup(
    workspace: WorkspaceState,
    sourceId: string,
    request: OperationRequest,
  ) {
    if (request.direction !== "right")
      throw new Error("Only a side-by-side split is supported");
    revealSplit(workspace);
    const destination = workspace.groups.find(
      (group) => group.id !== sourceId,
    )!;
    if (request.paneId !== undefined) {
      const pane = this.store.pane(
        workspace,
        requiredString(request, "paneId"),
      );
      for (const group of workspace.groups)
        group.paneIds = group.paneIds.filter((id) => id !== pane.id);
      destination.paneIds.push(pane.id);
      destination.activePaneId = pane.id;
    }
    selectGroup(workspace, destination);
    return { groupId: destination.id, paneId: destination.activePaneId };
  }

  splitPane(request: OperationRequest): { paneId: string } {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const target = this.store.pane(workspace, requiredString(request, "id"));
    normalizeGroups(workspace);
    const group = workspace.groups.find((item) =>
      item.paneIds.includes(target.id),
    )!;
    return { paneId: this.splitGroup(workspace, group.id, request).paneId };
  }

  async closePane(
    request: OperationRequest,
    { collapseSplit = true }: { collapseSplit?: boolean } = {},
  ): Promise<{ paneId: string; closed?: boolean }> {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const pane = this.store.pane(workspace, requiredString(request, "id"));
    if (
      request.includePinned !== undefined &&
      ![true, false, "true", "false"].includes(request.includePinned as boolean)
    )
      throw new Error("includePinned must be true or false");
    if (
      pane.pinned &&
      request.includePinned !== true &&
      request.includePinned !== "true"
    ) {
      normalizeGroups(workspace);
      const owner = workspace.groups!.find((group) =>
        group.paneIds.includes(pane.id),
      );
      const candidates = [
        owner,
        ...workspace.groups!.filter(
          (group) => group !== owner && !group.hidden,
        ),
      ].filter(Boolean);
      const next = candidates
        .flatMap((group) => group!.paneIds)
        .find((id) => !this.store.pane(workspace, id).pinned);
      if (workspace.activePaneId === pane.id && next)
        workspace.activePaneId = next;
      return { paneId: pane.id, closed: false };
    }
    if (
      pane.kind === "browser" &&
      !(await this.browsers.requestClose(this.browsers.browser(pane.browserId)))
    )
      return { paneId: pane.id, closed: false };
    workspace.closedTabs ??= [];
    const group = workspace.groups?.find((group) =>
      group.paneIds.includes(pane.id),
    );
    const survivingGroup =
      collapseSplit &&
      group?.paneIds.length === 1 &&
      (pane.kind !== "empty" || pane.launcher || pane.pinned) &&
      workspace.groups.every((item) => !item.hidden)
        ? workspace.groups.find((item) => item !== group)
        : undefined;
    workspace.closedTabs.push({
      groupId: group?.id,
      index: group?.paneIds.indexOf(pane.id),
      ...(survivingGroup ? { collapsedSplit: true } : {}),
      pane: structuredClone(pane),
      ...(pane.kind === "browser"
        ? { browser: structuredClone(this.browsers.browser(pane.browserId)) }
        : {}),
      ...(pane.kind === "terminal"
        ? {
            terminal: structuredClone(this.terminals.terminal(pane.terminalId)),
          }
        : {}),
    });
    this.pruneClosedTabs(workspace);
    if (pane.kind === "browser") {
      this.browsers.removeBrowser(this.browsers.browser(pane.browserId));
    } else {
      if (pane.kind === "terminal") {
        if (
          this.terminals.terminal(pane.terminalId).status !== "failed" &&
          this.terminals.terminal(pane.terminalId).pid !== 0
        )
          await this.terminals.stopProcess(pane.terminalId);
        this.store.data.terminals = this.store.data.terminals.filter(
          (item) => item.id !== pane.terminalId,
        );
      }
      workspace.panes = workspace.panes.filter((item) => item.id !== pane.id);
      if (!workspace.panes.length) {
        workspace.panes.push({
          id: randomUUID(),
          kind: "document",
          draftChat: true,
        });
      }
      normalizeGroups(workspace);
    }
    if (survivingGroup) showGroupOnly(workspace, survivingGroup);
    return { paneId: pane.id };
  }

  async removeConversation(
    request: OperationRequest,
  ): Promise<{ id: string; nativeId: string }> {
    const id = requiredString(request, "id");
    const result = await this.store.change(async () => {
      const conversation = this.store.conversation(id);
      const reviews = await this.reviews.list();
      const reason = conversationRemovalReason(
        { ...this.store.data, reviews },
        conversation,
      );
      if (reason) throw new Error(reason);
      if (this.conversations.isActive(id))
        throw new Error("Stop the current response before removing this chat.");
      this.conversations.reserve(id);
      try {
        const workspace = this.store.workspace(conversation.workspaceId);
        const saved = structuredClone(conversation);
        delete saved.detachedOwner;
        workspace.closedTabs = workspace.closedTabs?.filter(
          (record) =>
            record.pane.kind !== "conversation" ||
            record.pane.conversationId !== id,
        );
        const panes = workspace.panes.filter(
          (pane) => pane.kind === "conversation" && pane.conversationId === id,
        );
        for (const pane of panes)
          await this.closePane({
            op: "pane.close",
            workspace: workspace.id,
            id: pane.id,
          });
        const closed = [...(workspace.closedTabs ?? [])]
          .reverse()
          .find(
            (record) =>
              record.pane.kind === "conversation" &&
              record.pane.conversationId === id,
          );
        workspace.closedTabs = workspace.closedTabs?.filter(
          (record) =>
            record === closed ||
            record.pane.kind !== "conversation" ||
            record.pane.conversationId !== id,
        );
        if (closed) closed.conversation = saved;
        else
          (workspace.closedTabs ??= []).push({
            pane: {
              id: saved.paneId,
              kind: "conversation",
              conversationId: id,
            },
            conversation: saved,
          });
        this.pruneClosedTabs(workspace);
        this.store.data.conversations = this.store.data.conversations.filter(
          (item) => item.id !== id,
        );
        if (workspace.lastConversationId === id)
          workspace.lastConversationId = [...this.store.data.conversations]
            .reverse()
            .find((item) => item.workspaceId === workspace.id)?.id;
        normalizeGroups(workspace);
        await this.conversations.disposeController(
          id,
          conversation.detachedOwner,
        );
        return { id, nativeId: saved.nativeId };
      } finally {
        this.conversations.release(id);
      }
    });
    return result;
  }

  private pruneClosedTabs(workspace: WorkspaceState): void {
    if (!workspace.closedTabs) return;
    const retainedDraft = (
      item: NonNullable<WorkspaceState["closedTabs"]>[number],
    ) =>
      item.pane.kind === "untitled" &&
      !!this.store.data.drafts[documentKey(item.pane)]?.content;
    const ordinary = workspace.closedTabs.filter(
      (item) => !retainedDraft(item),
    );
    for (const expired of ordinary.slice(
      0,
      Math.max(0, ordinary.length - 50),
    )) {
      workspace.closedTabs.splice(workspace.closedTabs.indexOf(expired), 1);
      if (expired.pane.kind === "untitled")
        delete this.store.data.drafts[documentKey(expired.pane)];
    }
  }

  async reopenPane(request: OperationRequest): Promise<{ paneId: string }> {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const reference = workspace.closedTabs?.at(-1);
    if (!reference) throw new Error("No closed tab to reopen");
    const closed = await this.store.closedTab(workspace.id, reference);
    if (closed.terminal) {
      if (request.newShell !== true && request.newShell !== "true")
        throw new Error(
          "The terminal process has ended. Reopening starts a new shell without replaying commands; confirm with newShell=true.",
        );
      const opened = await this.terminals.openTerminal({
        op: "terminal.open",
        workspace: workspace.id,
        cwd: closed.terminal.cwd,
      });
      await this.store.change(() => {
        workspace.closedTabs!.pop();
        const pane = this.store.pane(workspace, opened.paneId);
        pane.pinned = closed.pane.pinned;
        this.restoreTabPosition(workspace, pane.id, closed);
      });
      return { paneId: opened.paneId };
    }
    const commit = (browser?: BrowserState) =>
      this.store.change(() => {
        if (
          this.store.closing ||
          !this.store.data.workspaces.includes(workspace) ||
          workspace.closedTabs?.at(-1) !== reference
        )
          throw new Error("The closed tab list changed. Try reopening again.");
        if (
          closed.conversation &&
          this.store.data.conversations.some(
            (active) =>
              active.id !== closed.conversation!.id &&
              active.provider === closed.conversation!.provider &&
              active.nativeId === closed.conversation!.nativeId,
          )
        )
          throw new Error(
            "This native session is already open. Use its existing chat.",
          );
        workspace.closedTabs!.pop();
        if (
          closed.conversation &&
          !this.store.data.conversations.some(
            (item) => item.id === closed.conversation!.id,
          )
        ) {
          closed.conversation.paneId = closed.pane.id;
          this.store.data.conversations.push(closed.conversation);
          workspace.lastConversationId = closed.conversation.id;
        }
        if (!workspace.panes.some((pane) => pane.id === closed.pane.id))
          workspace.panes.push(closed.pane);
        if (browser) this.store.data.browsers.push(browser);
        workspace.activePaneId = closed.pane.id;
        this.restoreTabPosition(workspace, closed.pane.id, closed);
        return { paneId: closed.pane.id };
      });
    if (closed.browser?.agentPage)
      await this.browsers.loadAgentPage(closed.browser);
    else if (closed.browser)
      return this.browsers.withReopenedBrowser(closed.browser, commit);
    return commit(closed.browser);
  }

  private restoreTabPosition(
    workspace: import("../types").WorkspaceState,
    id: string,
    closed: NonNullable<
      import("../types").WorkspaceState["closedTabs"]
    >[number],
  ): void {
    const reveal =
      closed.collapsedSplit &&
      workspace.groups.some(
        (group) => group.id === closed.groupId && group.hidden,
      );
    normalizeGroups(workspace);
    const target = workspace.groups!.find(
      (group) => group.id === closed.groupId,
    );
    if (!target) return;
    for (const group of workspace.groups!)
      group.paneIds = group.paneIds.filter((other) => other !== id);
    target.paneIds.splice(
      tabInsertionIndex(
        workspace,
        target.paneIds,
        id,
        Math.min(closed.index ?? target.paneIds.length, target.paneIds.length),
      ),
      0,
      id,
    );
    target.activePaneId = id;
    if (reveal) revealSplit(workspace);
    selectGroup(workspace, target);
  }

  private resizeGroup(workspace: WorkspaceState, value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value >= 1
    )
      throw new Error("Ratio must be a finite number between 0 and 1");
    if (workspace.groupLayout.type !== "split")
      throw new Error("Workspace has one group");
    workspace.groupLayout.ratio = value;
    return value;
  }

  resizePane(request: OperationRequest): { paneId: string; ratio: number } {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const pane = this.store.pane(workspace, requiredString(request, "id"));
    return {
      paneId: pane.id,
      ratio: this.resizeGroup(workspace, request.ratio),
    };
  }

  ensureGroup(request: OperationRequest): { groupId: string; paneId: string } {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    if (request.side !== "left" && request.side !== "right")
      throw new Error("side must be left or right");
    normalizeGroups(workspace);
    if (request.side === "right" && workspace.groups.length === 1)
      revealSplit(workspace);
    const group = orderedGroups(workspace)[request.side === "left" ? 0 : 1];
    selectGroup(workspace, group);
    return { groupId: group.id, paneId: group.activePaneId };
  }

  async moveConversation(request: OperationRequest): Promise<unknown> {
    const conversation = this.store.conversation(requiredString(request, "id"));
    if (conversation.transfer)
      throw new Error("Resolve the pending move to Linux first");
    const destination = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const source = this.store.workspace(conversation.workspaceId);
    if (conversation.handoffTerminalId)
      throw new Error(
        "Return this session from its CLI terminal to chat before moving it",
      );
    if (
      request.follow !== undefined &&
      ![true, false, "true", "false"].includes(
        request.follow as boolean | string,
      )
    )
      throw new Error("follow must be true or false");
    const follow =
      request.follow === undefined
        ? this.store.data.activeWorkspaceId === source.id &&
          source.activePaneId === conversation.paneId
        : request.follow === true || request.follow === "true";
    if (source.id === destination.id) {
      if (follow)
        await this.handle({ op: "conversation.show", id: conversation.id });
      return {
        id: conversation.id,
        workspaceId: destination.id,
        paneId: conversation.paneId,
        nativeId: conversation.nativeId,
        cwd: conversation.cwd,
        followed: follow,
      };
    }
    try {
      return await this.store.change(async () => {
        // Resolve membership again inside the shared mutation queue.
        if (
          conversation.workspaceId !== source.id ||
          conversation.transfer ||
          !this.store.data.workspaces.includes(destination)
        )
          throw new Error(
            "Conversation or destination changed; retry the move",
          );
        const reviewIds = new Set(
          (await this.reviews.list())
            .filter((review) => review.originConversationId === conversation.id)
            .map((review) => review.id),
        );
        const belongs = (pane: import("../types").PaneState) =>
          pane.id === conversation.paneId ||
          (pane.kind === "review" && reviewIds.has(pane.reviewId));
        const moved = source.panes.filter(belongs);
        if (!moved.some((pane) => pane.id === conversation.paneId))
          moved.unshift({
            id: conversation.paneId,
            kind: "conversation",
            conversationId: conversation.id,
          });
        const previousDestinationActive = destination.activePaneId;
        // Replace only a pristine placeholder, never another draft or live session.
        destination.panes = destination.panes.filter((pane) => {
          const draft = destination.chatDrafts?.[pane.id];
          return !(
            pane.kind === "document" &&
            !pane.pinned &&
            pane.draftChat &&
            !pane.filePath &&
            !draft?.text &&
            !draft?.localDraft &&
            !draft?.images?.length
          );
        });
        source.panes = source.panes.filter((pane) => !belongs(pane));
        for (const pane of moved)
          if (!destination.panes.some((existing) => existing.id === pane.id))
            destination.panes.push(pane);
        if (source.chatDrafts?.[conversation.paneId]) {
          destination.chatDrafts ??= {};
          destination.chatDrafts[conversation.paneId] =
            source.chatDrafts[conversation.paneId];
          delete source.chatDrafts[conversation.paneId];
        }
        const closedReviews = (source.closedTabs ?? []).filter(
          (item) =>
            item.pane.kind === "review" && reviewIds.has(item.pane.reviewId),
        );
        source.closedTabs = source.closedTabs?.filter(
          (item) => !belongs(item.pane),
        );
        if (closedReviews.length)
          (destination.closedTabs ??= []).push(...closedReviews);
        if (!source.panes.length) {
          const empty = {
            id: randomUUID(),
            kind: "document",
            draftChat: true,
          } as const;
          source.panes.push(empty);
        }
        if (!source.panes.some((pane) => pane.id === source.activePaneId))
          source.activePaneId = source.panes[0]!.id;
        conversation.workspaceId = destination.id;
        if (source.lastConversationId === conversation.id)
          source.lastConversationId = this.store.data.conversations.find(
            (item) => item.workspaceId === source.id,
          )?.id;
        destination.lastConversationId = conversation.id;
        destination.activePaneId =
          follow ||
          !destination.panes.some(
            (pane) => pane.id === previousDestinationActive,
          )
            ? conversation.paneId
            : previousDestinationActive;
        if (follow) this.store.data.activeWorkspaceId = destination.id;
        normalizeGroups(source);
        normalizeGroups(destination);
        await this.reviews.relocateOrigin(conversation.id, destination.id);
        return {
          id: conversation.id,
          workspaceId: destination.id,
          paneId: conversation.paneId,
          nativeId: conversation.nativeId,
          cwd: conversation.cwd,
          followed: follow,
        };
      });
    } catch (error) {
      // Review and workspace snapshots are separate files; reconcile after rollback
      // and at startup so a failed write cannot strand origin-bound feedback.
      await this.reviews.reconcileOrigins();
      throw error;
    }
  }

  async finishTransfer(id: string, transferId: string): Promise<void> {
    await this.store.change(async () => {
      const conversation = this.store.conversation(id);
      if (conversation.transfer?.id !== transferId)
        throw new Error("The pending conversation move changed");
      const workspace = this.store.workspace(conversation.workspaceId);
      const tabs = workspace.panes.filter(
        (pane) => pane.kind === "conversation" && pane.conversationId === id,
      );
      for (const tab of tabs)
        await this.closePane({
          op: "pane.close",
          workspace: workspace.id,
          id: tab.id,
          includePinned: true,
        });
      workspace.closedTabs = workspace.closedTabs?.filter(
        (record) =>
          record.pane.kind !== "conversation" ||
          record.pane.conversationId !== id,
      );
      this.store.data.conversations = this.store.data.conversations.filter(
        (item) => item !== conversation,
      );
      if (workspace.chatDrafts)
        delete workspace.chatDrafts[conversation.paneId];
      if (workspace.lastConversationId === id)
        workspace.lastConversationId = [...this.store.data.conversations]
          .reverse()
          .find((item) => item.workspaceId === workspace.id)?.id;
      (this.store.data.transferredCodexSessions ??= []).push(
        conversation.nativeId,
      );
    });
  }

  async handle(request: OperationRequest, trustedUi = false): Promise<unknown> {
    switch (request.op) {
      case "group.ensure":
        return this.store.change(() => this.ensureGroup(request));
      case "conversation.move":
        return this.moveConversation(request);
      case "workspace.create":
        return this.store.change(() => {
          const previous = this.store.data.activeWorkspaceId;
          const result = this.createWorkspace(requiredName(request));
          if (!trustedUi && request.focus !== true && request.focus !== "true")
            this.store.data.activeWorkspaceId = previous;
          return result;
        });

      case "workspace.prepare": {
        const { name, folders } = workspacePreparation(request);
        return this.store.change(async () => {
          const matches = this.store.data.workspaces.filter(
            (workspace) => workspace.name === name,
          );
          const archived =
            this.store.data.closedWorkspaces?.filter(
              ({ workspace }) => workspace.name === name,
            ) ?? [];
          if (matches.length + archived.length > 1)
            throw new Error(
              "More than one workspace has that name on the selected host",
            );
          if (archived.length)
            throw new Error(
              "A closed workspace has that name on the selected host. Reopen it before preparing it.",
            );
          const requested = await Promise.all(folders.map(directory));
          const prior = this.store.data.activeWorkspaceId;
          const workspace =
            matches[0] ?? this.store.workspace(this.createWorkspace(name).id);
          this.store.data.activeWorkspaceId = prior;
          workspace.folders = [
            ...new Set([...workspace.folders, ...requested]),
          ];
          return { id: workspace.id, folders: workspace.folders };
        });
      }

      case "workspace.reopen":
        return this.reopenWorkspace(request, trustedUi);

      case "workspace.rename":
        return this.store.change(() => {
          const workspace = this.store.workspace(requiredString(request, "id"));
          workspace.name = requiredName(request);
          return { id: workspace.id };
        });

      case "workspace.focus":
        return this.store.changeLayout(() => {
          const workspace = this.store.workspace(requiredString(request, "id"));
          this.store.data.activeWorkspaceId = workspace.id;
          return { id: workspace.id };
        });

      case "workspace.add-folder":
        return this.store.change(async () => {
          const workspace = this.store.workspace(requiredString(request, "id"));
          const folder = await directory(requiredString(request, "path"));
          if (!workspace.folders.includes(folder))
            workspace.folders.push(folder);
          return { id: workspace.id, folders: [...workspace.folders] };
        });

      case "workspace.remove-folder":
        return this.store.change(() => {
          const workspace = this.store.workspace(requiredString(request, "id"));
          workspace.folders = workspace.folders.filter(
            (folder) =>
              folder !== path.resolve(requiredString(request, "path")),
          );
          return { id: workspace.id, folders: workspace.folders };
        });

      case "workspace.settings": {
        if (
          !request.settings ||
          typeof request.settings !== "object" ||
          Array.isArray(request.settings)
        )
          throw new Error("settings must be an object");
        const settings = object(request.settings);
        if (
          settings.filesVisible !== undefined &&
          typeof settings.filesVisible !== "boolean"
        )
          throw new Error("filesVisible must be boolean");
        const allowed = ["filesVisible", "chatMaxWidth", "filesWidth"];
        if (Object.keys(settings).some((key) => !allowed.includes(key)))
          throw new Error("Unknown workspace setting");
        if (
          settings.chatMaxWidth !== undefined &&
          (typeof settings.chatMaxWidth !== "number" ||
            !Number.isFinite(settings.chatMaxWidth) ||
            settings.chatMaxWidth < 320 ||
            settings.chatMaxWidth > 10000)
        )
          throw new Error("chatMaxWidth must be between 320 and 10000");
        const width = settings.filesWidth;
        if (
          width !== undefined &&
          (typeof width !== "number" ||
            !Number.isFinite(width) ||
            width < 160 ||
            width > 800)
        )
          throw new Error("filesWidth must be between 160 and 800");
        const update = () => {
          const workspace = this.store.workspace(requiredString(request, "id"));
          workspace.settings = { ...workspace.settings, ...settings };
          return workspace.settings;
        };
        return settings.filesVisible !== undefined &&
          Object.keys(settings).length === 1
          ? this.store.changeLayout(update)
          : this.store.change(update);
      }

      case "group.focus":
      case "group.visibility":
      case "group.toggle-split":
        return this.store.changeLayout(() => this.groupOperation(request));

      case "group.split":
      case "group.resize":
      case "pane.move":
        return this.store.change(() => this.groupOperation(request));

      case "conversation.draft":
        return this.store.change(() => {
          const implicit = request.workspace === undefined;
          const workspace = implicit
            ? (this.store.data.workspaces.find(
                (item) => item.id === this.store.data.activeWorkspaceId,
              ) ??
              this.store.data.workspaces[0] ??
              this.store.workspace(this.createWorkspace("Untitled").id))
            : this.store.workspace(requiredString(request, "workspace"));
          const target = this.store.openingPane(workspace, request);
          if (request.sourcePane !== undefined) {
            const id = randomUUID();
            const provider =
              request.provider === undefined ? "codex" : providerId(request);
            if (
              request.initialSelection !== undefined &&
              (!request.initialSelection ||
                typeof request.initialSelection !== "object" ||
                Array.isArray(request.initialSelection))
            )
              throw new Error("Initial model selection must be an object");
            const selection = object(request.initialSelection);
            for (const [key, value] of Object.entries(selection))
              if (
                !["model", "reasoning"].includes(key) ||
                typeof value !== "string" ||
                !value.trim() ||
                value.length > 512
              )
                throw new Error("Invalid initial model selection");
            if (request.cwd !== undefined && typeof request.cwd !== "string")
              throw new Error("cwd must be a directory path");
            this.store.insertPane(
              workspace,
              { id, kind: "document", draftChat: true },
              request,
            );
            (workspace.chatDrafts ??= {})[id] = {
              text: "",
              provider,
              ...(Object.keys(selection).length
                ? { initialSelection: selection }
                : {}),
              ...(typeof request.cwd === "string" ? { cwd: request.cwd } : {}),
            };
            return { workspaceId: workspace.id, paneId: id };
          }
          const launcher =
            target.kind === "empty" && target.launcher ? target : undefined;
          const empty =
            launcher ??
            (implicit
              ? workspace.panes.find((pane) => {
                  const draft = workspace.chatDrafts?.[pane.id];
                  return (
                    pane.kind === "document" &&
                    !pane.pinned &&
                    pane.draftChat &&
                    !pane.filePath &&
                    !draft?.text &&
                    !draft?.localDraft &&
                    !draft?.images?.length &&
                    !draft?.skills?.length
                  );
                })
              : undefined);
          const id = empty?.id ?? randomUUID();
          if (launcher)
            workspace.panes[workspace.panes.indexOf(launcher)] = {
              id,
              pinned: launcher.pinned,
              kind: "document",
              draftChat: true,
            };
          else if (!empty)
            workspace.panes.push({ id, kind: "document", draftChat: true });
          workspace.activePaneId = id;
          if (implicit) this.store.data.activeWorkspaceId = workspace.id;
          normalizeGroups(workspace);
          const group = workspace.groups!.find((item) =>
            item.paneIds.includes(id),
          );
          if (group) {
            group.activePaneId = id;
            selectGroup(workspace, group);
          }
          return { workspaceId: workspace.id, paneId: id };
        });

      case "conversation.remove":
        return this.removeConversation(request);

      case "conversation.show":
        if (
          request.acknowledge !== undefined &&
          typeof request.acknowledge !== "boolean"
        )
          throw new Error("acknowledge must be boolean");
        return this.store.change(() => {
          const conversation = this.store.conversation(
            requiredString(request, "id"),
          );
          const workspace = this.store.workspace(conversation.workspaceId);
          if (!workspace.panes.some((pane) => pane.id === conversation.paneId))
            workspace.panes.push({
              id: conversation.paneId,
              kind: "conversation",
              conversationId: conversation.id,
            });
          workspace.activePaneId = conversation.paneId;
          this.store.data.activeWorkspaceId = workspace.id;
          if (request.acknowledge === true)
            acknowledgeConversation(conversation);
          return { paneId: conversation.paneId };
        });

      case "workspace.close":
        return this.store.change(async () => {
          const id = requiredString(request, "id");
          if (
            request.force !== true &&
            request.force !== "true" &&
            (this.store.data.conversations.some(
              (item) =>
                item.workspaceId === id &&
                (["working", "waiting", "starting"].includes(item.status) ||
                  hasRunningBackground(item)),
            ) ||
              [
                ...this.store.data.terminals,
                ...this.terminals.quickTerminalSummaries(),
              ].some(
                (item) =>
                  item.workspaceId === id &&
                  ["running", "starting"].includes(item.status),
              ))
          )
            throw new Error(
              "Workspace has running agents or terminals. Closing stops them. Confirm with force=true.",
            );
          const reviews = await this.reviews.list(id);
          if (
            reviews.some((review) =>
              review.rounds.some(
                (round) =>
                  (round.id === review.currentRoundId &&
                    round.status === "draft" &&
                    round.commentCount > 0) ||
                  (round.submission &&
                    round.submission.delivery.status !== "acknowledged"),
              ),
            )
          )
            throw new Error(
              "Workspace has private review drafts or undelivered feedback. Submit or delete current draft comments and resolve deliveries before closing.",
            );
          return this.closeWorkspace(id);
        });

      case "pane.new":
        return this.store.change(() => {
          const workspace = this.store.workspace(
            requiredString(request, "workspace"),
          );
          const paneId = randomUUID();
          if (request.sourcePane !== undefined)
            this.store.openingPane(workspace, request);
          this.store.insertPane(
            workspace,
            { id: paneId, kind: "empty", launcher: true },
            {
              ...request,
              focus: request.focus ?? true,
            },
          );
          return {
            paneId,
            groupId: workspace.groups!.find((group) =>
              group.paneIds.includes(paneId),
            )!.id,
          };
        });

      case "pane.split":
        return this.store.change(() => this.splitPane(request));

      case "pane.focus":
        return this.store.changeLayout(() => {
          const workspace = this.store.workspace(
            requiredString(request, "workspace"),
          );
          const pane = this.store.pane(
            workspace,
            requiredString(request, "id"),
          );
          workspace.activePaneId = pane.id;
          normalizeGroups(workspace);
          if (pane.kind === "conversation")
            workspace.lastConversationId = pane.conversationId;
          return { paneId: pane.id };
        });

      case "pane.reopen":
        return this.reopenPane(request);

      case "pane.pin":
        return this.store.change(() => {
          const workspace = this.store.workspace(
            requiredString(request, "workspace"),
          );
          const pane = this.store.pane(
            workspace,
            requiredString(request, "id"),
          );
          if (
            ![true, false, "true", "false"].includes(request.pinned as boolean)
          )
            throw new Error("pinned must be true or false");
          normalizeGroups(workspace);
          const pinned = request.pinned === true || request.pinned === "true";
          if (!!pane.pinned === pinned) return { paneId: pane.id, pinned };
          const group = workspace.groups!.find((group) =>
            group.paneIds.includes(pane.id),
          )!;
          group.paneIds = group.paneIds.filter((id) => id !== pane.id);
          pane.pinned = pinned;
          if (pinned && pane.kind === "empty") pane.launcher = true;
          const boundary = group.paneIds.filter(
            (id) => this.store.pane(workspace, id).pinned,
          ).length;
          group.paneIds.splice(boundary, 0, pane.id);
          return { paneId: pane.id, pinned };
        });

      case "pane.close-many":
        return this.store.change(async () => {
          const workspace = this.store.workspace(
            requiredString(request, "workspace"),
          );
          normalizeGroups(workspace);
          const group = workspace.groups!.find(
            (group) => group.id === requiredString(request, "group"),
          );
          if (!group) throw new Error("Group not found");
          const scope = requiredString(request, "scope");
          if (!["all", "others", "left", "right"].includes(scope))
            throw new Error("scope must be all, others, left or right");
          const id =
            typeof request.id === "string" ? request.id : group.activePaneId;
          const index = group.paneIds.indexOf(id);
          if (scope !== "all" && index < 0)
            throw new Error("Anchor tab not found in this pane");
          const targets = group.paneIds.filter(
            (other, position) =>
              !this.store.pane(workspace, other).pinned &&
              (scope === "all" ||
                (scope === "others"
                  ? other !== id
                  : scope === "left"
                    ? position < index
                    : position > index)),
          );
          const closed: string[] = [];
          for (const target of targets) {
            const result = await this.closePane({
              op: "pane.close",
              workspace: workspace.id,
              id: target,
            });
            if (result.closed === false) return { closed, cancelled: target };
            closed.push(target);
          }
          return { closed };
        });

      case "pane.close":
        return this.store.change(() => this.closePane(request));

      case "pane.resize":
        return this.store.change(() => this.resizePane(request));

      default:
        throw new Error("Unknown workspace operation");
    }
  }
}
