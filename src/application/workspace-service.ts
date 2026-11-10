import path from "node:path";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { OperationRequest, SplitDirection } from "../types";
import { normalizeGroups, replaceGroup } from "../workspace-layout";
import { ApplicationStateStore } from "./state";
import { requiredString, requiredName, object } from "./request";
import {
  leaf,
  replaceLeaf,
  removeLeaf,
  firstPane,
  containsPane,
  containingSplit,
  resizeSplit,
} from "./layout";
import type { ConversationApplicationService } from "./conversation-service";
import type { BrowserApplicationService } from "./browser-service";
import type { TerminalApplicationService } from "./terminal-service";
import type { ReviewApplicationService } from "./review-service";

export class WorkspaceApplicationService {
  constructor(
    private readonly store: ApplicationStateStore,
    private readonly conversations: Pick<
      ConversationApplicationService,
      "disposeController"
    >,
    private readonly browsers: Pick<
      BrowserApplicationService,
      "browser" | "removeBrowser" | "loadAgentPage" | "restoreBrowser"
    >,
    private readonly terminals: Pick<
      TerminalApplicationService,
      "terminal" | "stopProcess" | "restoreTerminal" | "openTerminal"
    >,
    private readonly reviews: Pick<
      ReviewApplicationService,
      "list" | "relocateOrigin" | "reconcileOrigins"
    >,
  ) {}
  createWorkspace(name: string): { id: string } {
    const id = randomUUID();
    const paneId = randomUUID();
    this.store.data.workspaces.push({
      id,
      name,
      folders: [],
      panes: [{ id: paneId, kind: "document", draftChat: true }],
      activePaneId: paneId,
      layout: leaf(paneId),
    });
    this.store.data.activeWorkspaceId = id;
    return { id };
  }

  async closeWorkspace(id: string): Promise<{ id: string }> {
    const index = this.store.data.workspaces.findIndex(
      (item) => item.id === id,
    );
    if (index < 0) throw new Error(`Workspace not found: ${id}`);
    this.store.data.closedWorkspaces ??= [];
    this.store.data.closedWorkspaces.push(
      structuredClone({
        workspace: this.store.data.workspaces[index]!,
        conversations: this.store.data.conversations.filter(
          (item) => item.workspaceId === id,
        ),
        terminals: this.store.data.terminals.filter(
          (item) => item.workspaceId === id,
        ),
        browsers: this.store.data.browsers.filter(
          (item) => item.workspaceId === id,
        ),
      }),
    );
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

  async reopenWorkspace(request: OperationRequest): Promise<{ id: string }> {
    const record =
      typeof request.id === "string"
        ? this.store.data.closedWorkspaces?.find(
            (item) => item.workspace.id === request.id,
          )
        : this.store.data.closedWorkspaces?.at(-1);
    if (!record) throw new Error("No closed workspace to reopen");
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
    await this.store.change(() => {
      this.store.data.closedWorkspaces =
        this.store.data.closedWorkspaces!.filter((item) => item !== record);
      this.store.data.workspaces.push(record.workspace);
      for (const conversation of record.conversations) {
        conversation.status = "ready";
        conversation.pendingPermissions = [];
        conversation.error = undefined;
        this.store.data.conversations.push(conversation);
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
    const id = requiredString(request, "id");
    if (request.op === "pane.move") {
      this.store.pane(workspace, id);
      const target = workspace.groups!.find(
        (group) => group.id === requiredString(request, "group"),
      );
      if (!target) throw new Error("Target group not found");
      for (const group of workspace.groups!)
        group.paneIds = group.paneIds.filter((pane) => pane !== id);
      target.paneIds.push(id);
      target.activePaneId = id;
      target.hidden = false;
      workspace.activePaneId = id;
      workspace.activeGroupId = target.id;
      return { paneId: id, groupId: target.id };
    }
    const group = workspace.groups!.find((item) => item.id === id);
    if (!group) throw new Error("Group not found");
    if (request.op === "group.split") {
      if (request.direction !== "right" && request.direction !== "down")
        throw new Error("Invalid split direction");
      const paneId =
        typeof request.paneId === "string" ? request.paneId : randomUUID();
      if (request.paneId) {
        this.store.pane(workspace, paneId);
        for (const source of workspace.groups!)
          source.paneIds = source.paneIds.filter((item) => item !== paneId);
      } else
        workspace.panes.push({ id: paneId, kind: "document", draftChat: true });
      if (!group.paneIds.length) {
        const placeholder = randomUUID();
        workspace.panes.push({
          id: placeholder,
          kind: "document",
          draftChat: true,
        });
        group.paneIds.push(placeholder);
        group.activePaneId = placeholder;
      }
      const next = {
        id: randomUUID(),
        paneIds: [paneId],
        activePaneId: paneId,
      };
      workspace.groups!.push(next);
      workspace.groupLayout = replaceGroup(workspace.groupLayout!, id, {
        type: "split",
        direction: request.direction,
        ratio: 0.5,
        first: leaf(id),
        second: leaf(next.id),
      });
      workspace.activeGroupId = next.id;
      workspace.activePaneId = paneId;
      workspace.zoomedGroupId = null;
      return { groupId: next.id, paneId };
    }
    if (request.op === "group.visibility") {
      group.hidden =
        typeof request.hidden === "boolean" ? request.hidden : !group.hidden;
      if (workspace.groups!.every((item) => item.hidden))
        throw new Error("At least one group must remain visible");
      if (group.hidden && workspace.activeGroupId === id) {
        const visible = workspace.groups!.find((item) => !item.hidden)!;
        workspace.activeGroupId = visible.id;
        workspace.activePaneId = visible.activePaneId;
      }
      if (group.hidden && workspace.zoomedGroupId === id)
        workspace.zoomedGroupId = null;
    } else if (request.op === "group.zoom") {
      workspace.zoomedGroupId = workspace.zoomedGroupId === id ? null : id;
      group.hidden = false;
      workspace.activeGroupId = id;
      workspace.activePaneId = group.activePaneId;
    } else if (request.op === "group.resize") {
      if (
        typeof request.ratio !== "number" ||
        !Number.isFinite(request.ratio) ||
        request.ratio <= 0 ||
        request.ratio >= 1
      )
        throw new Error("Invalid split ratio");
      let target = containingSplit(workspace.groupLayout!, id);
      if (request.path !== undefined) {
        if (
          !Array.isArray(request.path) ||
          request.path.length > 16 ||
          request.path.some((part) => part !== 0 && part !== 1)
        )
          throw new Error("Split path must contain only 0 or 1");
        let current = workspace.groupLayout!;
        for (const part of request.path) {
          if (current.type !== "split") throw new Error("Split layout changed");
          current = part === 0 ? current.first : current.second;
        }
        if (current.type !== "split" || !containsPane(current, id))
          throw new Error("Split layout changed");
        target = current;
      }
      if (!target) throw new Error("Group is not split");
      workspace.groupLayout = resizeSplit(
        workspace.groupLayout!,
        target,
        request.ratio,
      );
    } else {
      group.hidden = false;
      workspace.activeGroupId = id;
      workspace.activePaneId = group.activePaneId;
    }
    return { groupId: id };
  }

  splitPane(request: OperationRequest): { paneId: string } {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const target = this.store.pane(workspace, requiredString(request, "id"));
    normalizeGroups(workspace);
    const group = workspace.groups!.find((item) =>
      item.paneIds.includes(target.id),
    )!;
    const direction = request.direction;
    if (direction !== "right" && direction !== "down") {
      throw new Error("direction must be right or down");
    }
    const paneId = randomUUID();
    workspace.panes.push({ id: paneId, kind: "document", draftChat: true });
    const nextGroup = {
      id: randomUUID(),
      paneIds: [paneId],
      activePaneId: paneId,
    };
    workspace.groups!.push(nextGroup);
    workspace.groupLayout = replaceGroup(workspace.groupLayout!, group.id, {
      type: "split",
      direction,
      ratio: 0.5,
      first: leaf(group.id),
      second: leaf(nextGroup.id),
    });
    workspace.activeGroupId = nextGroup.id;
    workspace.zoomedGroupId = null;
    workspace.layout = replaceLeaf(workspace.layout, target.id, {
      type: "split",
      direction: direction as SplitDirection,
      ratio: 0.5,
      first: leaf(target.id),
      second: leaf(paneId),
    });
    workspace.activePaneId = paneId;
    return { paneId };
  }

  async closePane(request: OperationRequest): Promise<{ paneId: string }> {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const pane = this.store.pane(workspace, requiredString(request, "id"));
    workspace.closedTabs ??= [];
    workspace.closedTabs.push({
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
    if (workspace.closedTabs.length > 50) workspace.closedTabs.shift();
    if (pane.kind === "browser") {
      this.browsers.removeBrowser(this.browsers.browser(pane.browserId));
      return { paneId: pane.id };
    }
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
    workspace.layout = removeLeaf(workspace.layout, pane.id) ?? leaf("");
    if (!workspace.panes.length) {
      const empty = {
        id: randomUUID(),
        kind: "document",
        draftChat: true,
      } as const;
      workspace.panes.push(empty);
      workspace.layout = leaf(empty.id);
    }
    if (workspace.activePaneId === pane.id)
      workspace.activePaneId = firstPane(workspace.layout);
    return { paneId: pane.id };
  }

  async reopenPane(request: OperationRequest): Promise<{ paneId: string }> {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const closed = workspace.closedTabs?.at(-1);
    if (!closed) throw new Error("No closed tab to reopen");
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
      });
      return { paneId: opened.paneId };
    }
    if (closed.browser) {
      if (closed.browser.agentPage)
        await this.browsers.loadAgentPage(closed.browser);
      else {
        this.store.data.browsers.push(closed.browser);
        try {
          await this.browsers.restoreBrowser(closed.browser);
        } catch (error) {
          this.browsers.removeBrowser(closed.browser);
          throw error;
        }
      }
    }
    return this.store.change(() => {
      workspace.closedTabs!.pop();
      if (!workspace.panes.some((pane) => pane.id === closed.pane.id))
        workspace.panes.push(closed.pane);
      if (closed.browser?.agentPage)
        this.store.data.browsers.push(closed.browser);
      workspace.activePaneId = closed.pane.id;
      return { paneId: closed.pane.id };
    });
  }

  resizePane(request: OperationRequest): {
    paneId: string;
    ratio: number;
  } {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const pane = this.store.pane(workspace, requiredString(request, "id"));
    const ratio = request.ratio;
    if (
      typeof ratio !== "number" ||
      !Number.isFinite(ratio) ||
      ratio <= 0 ||
      ratio >= 1
    ) {
      throw new Error("ratio must be a finite number between 0 and 1");
    }
    normalizeGroups(workspace);
    const group = workspace.groups!.find((item) =>
      item.paneIds.includes(pane.id),
    );
    const groupSplit =
      group && containingSplit(workspace.groupLayout!, group.id);
    if (groupSplit)
      workspace.groupLayout = resizeSplit(
        workspace.groupLayout!,
        groupSplit,
        ratio,
      );
    const target = containingSplit(workspace.layout, pane.id);
    if (!target && !groupSplit) throw new Error("Pane is not inside a split");
    if (target) workspace.layout = resizeSplit(workspace.layout, target, ratio);
    return { paneId: pane.id, ratio };
  }

  ensureGroup(request: OperationRequest): { groupId: string; paneId: string } {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    if (request.side !== "left" && request.side !== "right")
      throw new Error("side must be left or right");
    normalizeGroups(workspace);
    const leaves = (layout: import("../types").Layout): string[] =>
      layout.type === "leaf"
        ? [layout.paneId]
        : [...leaves(layout.first), ...leaves(layout.second)];
    const ordered = leaves(workspace.groupLayout!);
    const soleIsChat = workspace.panes.some(
      (pane) =>
        pane.kind === "conversation" ||
        pane.kind === "terminal" ||
        (pane.kind === "document" && !pane.filePath),
    );
    const existing =
      ordered.length > 1 ||
      (request.side === "right" ? soleIsChat : !soleIsChat);
    if (existing) {
      const id = request.side === "left" ? ordered[0]! : ordered.at(-1)!;
      const group = workspace.groups!.find((item) => item.id === id)!;
      group.hidden = false;
      workspace.activeGroupId = id;
      workspace.activePaneId = group.activePaneId;
      workspace.zoomedGroupId = null;
      return { groupId: id, paneId: group.activePaneId };
    }
    const paneId = randomUUID(),
      groupId = randomUUID();
    workspace.panes.push(
      request.side === "left"
        ? { id: paneId, kind: "empty" }
        : { id: paneId, kind: "document", draftChat: true },
    );
    workspace.groups!.push({
      id: groupId,
      paneIds: [paneId],
      activePaneId: paneId,
    });
    const next = leaf(groupId),
      previous = workspace.groupLayout!;
    workspace.groupLayout = {
      type: "split",
      direction: "right",
      ratio: 0.5,
      first: request.side === "left" ? next : previous,
      second: request.side === "left" ? previous : next,
    };
    workspace.layout = {
      type: "split",
      direction: "right",
      ratio: 0.5,
      first: request.side === "left" ? leaf(paneId) : workspace.layout,
      second: request.side === "left" ? workspace.layout : leaf(paneId),
    };
    workspace.activeGroupId = groupId;
    workspace.activePaneId = paneId;
    workspace.zoomedGroupId = null;
    return { groupId, paneId };
  }

  async moveConversation(request: OperationRequest): Promise<unknown> {
    const conversation = this.store.conversation(requiredString(request, "id"));
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
        const destinationPaneIds = new Set(
          destination.panes.map((pane) => pane.id),
        );
        destination.panes = destination.panes.filter((pane) => {
          const draft = destination.chatDrafts?.[pane.id];
          return !(
            pane.kind === "document" &&
            pane.draftChat &&
            !pane.filePath &&
            !draft?.text &&
            !draft?.images?.length
          );
        });
        for (const id of destinationPaneIds) {
          if (!destination.panes.some((pane) => pane.id === id))
            destination.layout = removeLeaf(destination.layout, id) ?? leaf("");
        }
        source.panes = source.panes.filter((pane) => !belongs(pane));
        for (const pane of moved) {
          source.layout = removeLeaf(source.layout, pane.id) ?? leaf("");
          if (!destination.panes.some((existing) => existing.id === pane.id))
            destination.panes.push(pane);
          if (!containsPane(destination.layout, pane.id))
            destination.layout = firstPane(destination.layout)
              ? {
                  type: "split",
                  direction: "right",
                  ratio: 0.5,
                  first: destination.layout,
                  second: leaf(pane.id),
                }
              : leaf(pane.id);
        }
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
          source.layout = leaf(empty.id);
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

      case "workspace.reopen":
        return this.reopenWorkspace(request);

      case "workspace.rename":
        return this.store.change(() => {
          const workspace = this.store.workspace(requiredString(request, "id"));
          workspace.name = requiredName(request);
          return { id: workspace.id };
        });

      case "workspace.focus":
        return this.store.change(() => {
          const workspace = this.store.workspace(requiredString(request, "id"));
          this.store.data.activeWorkspaceId = workspace.id;
          return { id: workspace.id };
        });

      case "workspace.add-folder":
        return this.store.change(async () => {
          const workspace = this.store.workspace(requiredString(request, "id"));
          const folder = path.resolve(requiredString(request, "path"));
          if (!(await stat(folder)).isDirectory()) {
            throw new Error("Folder path is not a directory");
          }
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

      case "workspace.settings":
        return this.store.change(() => {
          const workspace = this.store.workspace(requiredString(request, "id"));
          if (
            !request.settings ||
            typeof request.settings !== "object" ||
            Array.isArray(request.settings)
          )
            throw new Error("settings must be an object");
          const settings = object(request.settings);
          for (const key of ["filesVisible", "workspacesVisible"])
            if (
              settings[key] !== undefined &&
              typeof settings[key] !== "boolean"
            )
              throw new Error(`${key} must be boolean`);
          const allowed = [
            "filesVisible",
            "workspacesVisible",
            "chatMaxWidth",
            "workspacesWidth",
            "filesWidth",
          ];
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
          for (const key of ["workspacesWidth", "filesWidth"]) {
            const width = settings[key];
            if (
              width !== undefined &&
              (typeof width !== "number" ||
                !Number.isFinite(width) ||
                width < 160 ||
                width > 800)
            )
              throw new Error(`${key} must be between 160 and 800`);
          }
          workspace.settings = { ...workspace.settings, ...settings };
          return workspace.settings;
        });

      case "group.split":

      case "group.focus":

      case "group.visibility":

      case "group.zoom":

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
          const empty = implicit
            ? workspace.panes.find((pane) => {
                const draft = workspace.chatDrafts?.[pane.id];
                return (
                  pane.kind === "document" &&
                  pane.draftChat &&
                  !pane.filePath &&
                  !draft?.text &&
                  !draft?.images?.length &&
                  !draft?.skills?.length
                );
              })
            : undefined;
          const id = empty?.id ?? randomUUID();
          if (!empty)
            workspace.panes.push({ id, kind: "document", draftChat: true });
          workspace.activePaneId = id;
          if (implicit) this.store.data.activeWorkspaceId = workspace.id;
          normalizeGroups(workspace);
          const group = workspace.groups!.find((item) =>
            item.paneIds.includes(id),
          );
          if (group) {
            group.hidden = false;
            group.activePaneId = id;
            workspace.activeGroupId = group.id;
          }
          workspace.zoomedGroupId = null;
          return { workspaceId: workspace.id, paneId: id };
        });

      case "conversation.show":
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
                ["working", "waiting", "starting"].includes(item.status),
            ) ||
              this.store.data.terminals.some(
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

      case "pane.split":
        return this.store.change(() => this.splitPane(request));

      case "pane.focus":
        return this.store.change(() => {
          const workspace = this.store.workspace(
            requiredString(request, "workspace"),
          );
          const pane = this.store.pane(
            workspace,
            requiredString(request, "id"),
          );
          workspace.activePaneId = pane.id;
          normalizeGroups(workspace);
          const group = workspace.groups!.find((group) =>
            group.paneIds.includes(pane.id),
          );
          if (group) {
            group.hidden = false;
            if (workspace.zoomedGroupId && workspace.zoomedGroupId !== group.id)
              workspace.zoomedGroupId = null;
          }
          if (pane.kind === "conversation")
            workspace.lastConversationId = pane.conversationId;
          return { paneId: pane.id };
        });

      case "pane.reopen":
        return this.reopenPane(request);

      case "pane.close":
        return this.store.change(() => this.closePane(request));

      case "pane.resize":
        return this.store.change(() => this.resizePane(request));

      default:
        throw new Error("Unknown workspace operation");
    }
  }
}
