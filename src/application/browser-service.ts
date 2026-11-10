import { nativeKeyInput, resolveKeybinding } from "../keyboard";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { app, type BrowserWindow, type Session } from "electron";
import { BrowserService, type BrowserEvent } from "../browser";
import { AgentPageService } from "../agent-pages";
import { BrowserAddons } from "../browser-addons";
import type {
  BrowserState,
  BrowserRectangle,
  OperationRequest,
} from "../types";
import { ApplicationStateStore } from "./state";
import { requiredString } from "./request";
import { leaf, replaceLeaf, removeLeaf, firstPane } from "./layout";
export interface BrowserConversationPort {
  isActive(id: string): boolean;
  send(request: OperationRequest): Promise<{ id: string; status: string }>;
}
export class BrowserApplicationService {
  private browserService?: BrowserService;
  private agentPages?: AgentPageService;
  private browserAddons?: BrowserAddons;
  private selectedBrowserContents?: number;
  private synchronizingBrowserSelection = false;
  private browserLoads = new Map<string, number>();
  private browserAdmissions = new Map<string, AbortController>();
  private browserInitializations = new Map<string, Promise<unknown>>();
  private browserWindow?: BrowserWindow;
  constructor(
    private readonly store: ApplicationStateStore,
    private readonly conversations: BrowserConversationPort,
  ) {}
  async toggleBlocking(id: string, enabled: boolean): Promise<void> {
    if (!this.browserAddons) throw new Error("Browser add-ons unavailable");
    await this.browserAddons.toggle(this.browser(id).url, enabled);
    this.requireBrowserService().reload(id);
  }
  shutdown(): void {
    for (const controller of this.browserAdmissions.values())
      controller.abort();
    this.browserAdmissions.clear();
    this.browserAddons?.dispose();
    this.browserService?.dispose();
    this.agentPages?.dispose();
  }
  attachAgentPageHost(window: BrowserWindow, session: Session): void {
    this.agentPages = new AgentPageService({
      window,
      session,
      preloadPath: path.join(__dirname, "agent-page-preload.cjs"),
      onSubmit: async (submission) => {
        const browser = this.browser(submission.pageId);
        await this.store.serialize(async () => {
          if (
            !browser.agentPage ||
            browser.agentPage.conversationId !== submission.conversationId
          )
            throw new Error("Wrong page origin");
          if (browser.agentPage.submission)
            throw new Error(
              "Page already submitted or uncertain; do not resend",
            );
          if (this.conversations.isActive(submission.conversationId)) {
            browser.agentPage.error =
              "Origin conversation is busy. Response was not sent; try again after it finishes.";
            await this.store.persist();
            this.store.notify();
            throw new Error(browser.agentPage.error);
          }
          browser.agentPage.error = undefined;
          browser.agentPage.submission = {
            id: submission.submissionId,
            payload: submission.payload,
            status: "sending",
          };
          try {
            await this.store.persist();
          } catch (error) {
            browser.agentPage.submission = undefined;
            throw error;
          }
          this.store.notify();
        });
        try {
          await this.conversations.send({
            op: "conversation.send",
            id: submission.conversationId,
            pageId: submission.pageId,
            submissionId: submission.submissionId,
            text: JSON.stringify({
              pageId: submission.pageId,
              submissionId: submission.submissionId,
              response: submission.payload,
            }),
          });
        } catch (error) {
          // sendConversation throws only before native turn dispatch; asynchronous
          // turn failures are marked uncertain by its completion handler below.
          browser.agentPage!.submission = undefined;
          browser.agentPage!.error = `Response was not sent: ${error instanceof Error ? error.message : String(error)}`;
          await this.store.serialize(() => this.store.persist());
          this.store.notify();
          throw error;
        }
      },
    });
    for (const browser of this.store.data.browsers.filter(
      (item) => item.agentPage,
    ))
      void this.loadAgentPage(browser).catch((error) => {
        browser.error = String(error);
        this.store.notify();
      });
  }

  async loadAgentPage(record: BrowserState): Promise<void> {
    if (!this.agentPages || !record.agentPage)
      throw new Error("Agent page host unavailable");
    const page = await this.agentPages.open({
      id: record.id,
      workspaceId: record.workspaceId,
      conversationId: record.agentPage.conversationId,
      path: record.agentPage.path,
    });
    record.url = page.url;
    record.loading = false;
    if (record.agentPage.submission?.status === "sending")
      record.agentPage.submission.status = "uncertain";
    const syncSubmission = () => {
      if (
        !this.store.closing &&
        this.agentPages?.list().some((page) => page.id === record.id)
      )
        this.agentPages.setSubmissionState(
          record.id,
          record.agentPage?.submission?.status ?? null,
        );
    };
    const contents = this.agentPages.getWebContents(record.id);
    contents.on("did-finish-load", syncSubmission);
    this.routeNativeKeys(contents, record.id, "agent-page");
    contents.on("focus", () => {
      if (record.workspaceId !== this.store.data.activeWorkspaceId) return;
      const workspace = this.store.data.workspaces.find(
        (item) => item.id === record.workspaceId,
      );
      if (workspace && workspace.activePaneId !== record.paneId)
        void this.store
          .change(() => {
            workspace.activePaneId = record.paneId;
          })
          .catch(() => undefined);
    });
    syncSubmission();
    this.store.notify();
  }

  async openAgentPage(
    request: OperationRequest,
  ): Promise<{ id: string; paneId: string }> {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const conversation = this.store.conversation(
      requiredString(request, "conversation"),
    );
    if (conversation.workspaceId !== workspace.id)
      throw new Error("Page origin must belong to workspace");
    const filePath = await realpath(requiredString(request, "path"));
    const id = randomUUID(),
      paneId = randomUUID();
    const record: BrowserState = {
      id,
      paneId,
      workspaceId: workspace.id,
      url: "",
      title: path.basename(filePath),
      loading: true,
      visible: false,
      canGoBack: false,
      canGoForward: false,
      agentPage: { path: filePath, conversationId: conversation.id },
    };
    await this.loadAgentPage(record);
    try {
      return await this.store.change(() => {
        workspace.panes.push({ id: paneId, kind: "browser", browserId: id });
        workspace.activePaneId = paneId;
        this.store.data.browsers.push(record);
        return { id, paneId };
      });
    } catch (error) {
      this.agentPages?.close(id);
      throw error;
    }
  }

  browserPermissionDenied(contentsId: number, permission: string): void {
    const browser = this.store.data.browsers.find(
      (item) =>
        !item.agentPage &&
        this.browserService?.list().some((view) => view.id === item.id) &&
        this.browserService.getWebContents(item.id).id === contentsId,
    );
    if (!browser) return;
    const label =
      permission === "geolocation"
        ? "Location"
        : permission === "media"
          ? "Camera or microphone"
          : permission === "notifications"
            ? "Notifications"
            : permission.replaceAll("-", " ");
    browser.permissionDenied = `${label} permission is unavailable`;
    this.store.notify();
    this.store.schedulePersist();
  }

  attachBrowserHost(
    window: BrowserWindow,
    session: Session,
    downloadDirectory: string,
  ): void {
    this.browserWindow = window;
    const browserForContents = (contents: import("electron").WebContents) =>
      this.store.data.browsers.find(
        (item) =>
          this.browserService
            ?.list()
            .some((resource) => resource.id === item.id) &&
          this.browserService?.getWebContents(item.id)?.id === contents.id,
      );
    this.browserAddons = new BrowserAddons({
      directory: path.join(this.store.directory, "browser-addons"),
      session,
      window,
      changed: () => {
        for (const browser of this.store.data.browsers)
          browser.addons = this.browserAddons?.status(browser.url);
        this.store.notify();
      },
      createTab: async (url) => {
        const workspace = this.store.data.activeWorkspaceId;
        if (!workspace)
          throw new Error("No active workspace for extension tab");
        const record = await this.openBrowser(
          { op: "browser.open", workspace, url },
          true,
        );
        return this.requireBrowserService().getWebContents(record.id);
      },
      selectTab: (contents) => {
        if (this.synchronizingBrowserSelection) return;
        const browser = browserForContents(contents);
        if (
          !browser ||
          browser.workspaceId !== this.store.data.activeWorkspaceId
        )
          return;
        void this.store
          .change(() => {
            const workspace = this.store.workspace(browser.workspaceId);
            workspace.activePaneId = browser.paneId;
          })
          .then(() => contents.focus())
          .catch(() => undefined);
      },
      removeTab: (contents) => {
        const browser = browserForContents(contents);
        if (browser)
          void this.store
            .change(() => this.removeBrowser(browser))
            .catch(() => undefined);
      },
    });
    this.browserService = new BrowserService({
      isAllowedExtensionUrl: (url) => this.browserAddons?.allows(url) ?? false,
      window,
      session,
      downloadDirectory,
      onViewCreated: (contents, id) => {
        // open() has registered the resource before this callback and has not awaited navigation.
        this.browserService!.setVisible(id, false);
        this.synchronizingBrowserSelection = true;
        try {
          this.browserAddons!.register(contents);
        } finally {
          this.synchronizingBrowserSelection = false;
        }
        this.selectedBrowserContents = undefined;
        const record = this.store.data.browsers.find((item) => item.id === id);
        if (
          record &&
          this.browserService?.getWebContents(id)?.id === contents.id
        )
          record.nativeTabId = contents.id;
        contents.on("focus", () => {
          const focused = this.store.data.browsers.find(
            (item) => item.id === id,
          );
          if (
            !focused ||
            focused.workspaceId !== this.store.data.activeWorkspaceId
          )
            return;
          this.selectBrowserContents(contents);
          const browser = this.store.data.browsers.find(
            (item) => item.id === id,
          );
          const workspace =
            browser &&
            this.store.data.workspaces.find(
              (item) => item.id === browser.workspaceId,
            );
          if (browser && workspace && workspace.activePaneId !== browser.paneId)
            void this.store
              .change(() => {
                workspace.activePaneId = browser.paneId;
              })
              .catch(() => undefined);
        });
        this.routeNativeKeys(contents, id, "browser");
      },
    });
    this.browserService.onEvent((event) => this.browserEvent(event));
    for (const browser of this.store.data.browsers.filter(
      (item) => !item.agentPage,
    ))
      void this.restoreBrowser(browser).catch(() => undefined);
  }
  private routeNativeKeys(
    contents: Electron.WebContents,
    id: string,
    surface: "browser" | "agent-page",
  ): void {
    contents.on("before-input-event", (event, input) => {
      const match = resolveKeybinding(
        nativeKeyInput(input),
        process.platform === "darwin" ? "darwin" : "linux",
        surface,
      );
      if (!match) return;
      event.preventDefault();
      if (!match.dispatch) return;
      this.browserWindow?.webContents.focus();
      this.browserWindow?.webContents.send("cod:command", {
        command: match.command,
        browserId: id,
      });
    });
  }

  browserFocus(id: string): void {
    const browser = this.store.data.browsers.find(
      (item) =>
        item.id === id &&
        item.workspaceId === this.store.data.activeWorkspaceId,
    );
    if (!browser) return;
    try {
      if (browser.agentPage) this.agentPages?.focus(id);
      else this.browserService?.focus(id);
    } catch {
      /* A hidden or closed native view cannot receive focus. */
    }
  }

  browserSelect(id: string): void {
    const browser = this.store.data.browsers.find(
      (item) =>
        item.id === id &&
        item.workspaceId === this.store.data.activeWorkspaceId &&
        !item.agentPage,
    );
    if (!browser || !this.browserService?.list().some((view) => view.id === id))
      return;
    this.selectBrowserContents(this.browserService.getWebContents(id));
    const workspace = this.store.workspace(browser.workspaceId);
    if (workspace.activePaneId !== browser.paneId) {
      workspace.activePaneId = browser.paneId;
      this.store.notify();
      this.store.schedulePersist();
    }
  }

  browserLayout(rectangles: BrowserRectangle[]): void {
    const service = this.browserService,
      window = this.browserWindow;
    if (
      !service ||
      !window ||
      window.isDestroyed() ||
      !Array.isArray(rectangles)
    )
      return;
    const active = this.store.data.workspaces.find(
      (item) => item.id === this.store.data.activeWorkspaceId,
    );
    const browser =
      this.store.data.browsers.find(
        (item) =>
          item.workspaceId === active?.id &&
          item.paneId === active.activePaneId &&
          !item.agentPage,
      ) ??
      this.store.data.browsers.find(
        (item) =>
          item.workspaceId === active?.id &&
          !item.agentPage &&
          rectangles.some((rectangle) => rectangle.id === item.id),
      );
    if (browser && service.list().some((item) => item.id === browser.id)) {
      const contents = service.getWebContents(browser.id);
      if (contents.id !== this.selectedBrowserContents) {
        this.selectBrowserContents(contents);
      }
    }
    const [width, height] = window.getContentSize();
    for (const item of [
      ...service.list(),
      ...(this.agentPages?.list() ?? []),
    ]) {
      const itemService = this.store.data.browsers.find(
        (browser) => browser.id === item.id,
      )?.agentPage
        ? this.agentPages!
        : service;
      const rect = rectangles.find((rect) => rect && rect.id === item.id);
      const visible = Boolean(
        rect &&
        item.workspaceId === this.store.data.activeWorkspaceId &&
        [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.width >= 1 &&
        rect.height >= 1 &&
        rect.x + rect.width <= width + 1 &&
        rect.y + rect.height <= height + 1,
      );
      if (visible && rect)
        itemService.setBounds(item.id, {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.max(1, Math.floor(rect.width)),
          height: Math.max(1, Math.floor(rect.height)),
        });
      if (item.visible !== visible) itemService.setVisible(item.id, visible);
    }
  }
  selectBrowserContents(contents: import("electron").WebContents): void {
    this.synchronizingBrowserSelection = true;
    try {
      this.browserAddons?.select(contents);
      this.selectedBrowserContents = contents.id;
    } finally {
      this.synchronizingBrowserSelection = false;
    }
  }

  requireBrowserService(): BrowserService {
    if (!this.browserService || this.store.closing)
      throw new Error("Browser host unavailable");
    return this.browserService;
  }
  browser(id: string): BrowserState {
    const record = this.store.data.browsers.find((item) => item.id === id);
    if (!record) throw new Error(`Unknown browser: ${id}`);
    return record;
  }
  browserUrl(url: string): string {
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) &&
      parsed.href !== "about:blank"
    )
      throw new Error("Unsupported browser URL protocol");
    return parsed.href;
  }
  async openBrowser(
    request: OperationRequest,
    extension = false,
  ): Promise<BrowserState> {
    const requested = requiredString(request, "url");
    const url =
      extension && this.browserAddons?.allows(requested)
        ? requested
        : this.browserUrl(requested);
    const record = await this.store.serialize(async () => {
      this.requireBrowserService();
      const workspace = this.store.workspace(
        requiredString(request, "workspace"),
      );
      const id = randomUUID(),
        active = this.store.pane(workspace, workspace.activePaneId);
      const paneId =
        active.kind === "document" && !active.filePath && !active.draftChat
          ? active.id
          : randomUUID();
      if (paneId === active.id)
        workspace.panes[workspace.panes.indexOf(active)] = {
          id: paneId,
          kind: "browser",
          browserId: id,
        };
      else {
        workspace.panes.push({ id: paneId, kind: "browser", browserId: id });
        workspace.layout = replaceLeaf(workspace.layout, active.id, {
          type: "split",
          direction: "right",
          ratio: 0.5,
          first: leaf(active.id),
          second: leaf(paneId),
        });
      }
      workspace.activePaneId = paneId;
      const record: BrowserState = {
        id,
        paneId,
        workspaceId: workspace.id,
        url,
        title: "",
        loading: true,
        canGoBack: false,
        canGoForward: false,
        visible: false,
        addons: this.browserAddons?.status(url),
      };
      this.store.data.browsers.push(record);
      try {
        await this.store.persist();
      } catch (error) {
        this.removeBrowser(record);
        throw error;
      }
      this.store.notify();
      return record;
    });
    await this.loadBrowser(record, url);
    return structuredClone(this.browser(record.id));
  }
  async restoreBrowser(record: BrowserState): Promise<void> {
    if (!record.error) return this.loadBrowser(record, record.url);
    const restoredFailure = {
      url: record.url,
      error: record.error,
      title: record.title,
      lastSuccessfulUrl: record.lastSuccessfulUrl,
    };
    const snapshot = await this.requireBrowserService().open({
      id: record.id,
      workspaceId: record.workspaceId,
      url: "about:blank",
      restoredFailure,
    });
    Object.assign(record, snapshot);
    this.store.schedulePersist();
    this.store.notify();
  }
  async navigateBrowser(id: string, url: string): Promise<BrowserState> {
    const record = this.browser(id);
    if (record.agentPage)
      throw new Error("Registered agent pages cannot navigate to other sites");
    await this.loadBrowser(record, this.browserUrl(url));
    return structuredClone(this.browser(id));
  }
  async loadBrowser(record: BrowserState, url: string): Promise<void> {
    const service = this.requireBrowserService();
    if (!this.store.data.browsers.some((item) => item.id === record.id))
      throw new Error("Browser closed");
    const generation = (this.browserLoads.get(record.id) ?? 0) + 1;
    this.browserLoads.set(record.id, generation);
    this.browserAdmissions.get(record.id)?.abort();
    const admission = new AbortController();
    this.browserAdmissions.set(record.id, admission);
    record.loading = true;
    record.error = undefined;
    record.permissionDenied = undefined;
    record.url = url;
    this.store.notify();
    const current = () =>
      this.store.data.browsers.some((item) => item.id === record.id) &&
      this.browserLoads.get(record.id) === generation &&
      !this.store.closing;
    try {
      let initialization = this.browserInitializations.get(record.id);
      if (
        !initialization &&
        !service.list().some((item) => item.id === record.id)
      ) {
        initialization = service.open({
          id: record.id,
          workspaceId: record.workspaceId,
          url: "about:blank",
        });
        this.browserInitializations.set(record.id, initialization);
        void initialization
          .finally(() => {
            if (this.browserInitializations.get(record.id) === initialization)
              this.browserInitializations.delete(record.id);
          })
          .catch(() => undefined);
      }
      if (initialization) await initialization;
      await this.browserAddons?.whenReady(admission.signal);
      if (!current())
        throw new Error("Browser navigation superseded or closed");
      const snapshot = await service.navigate(record.id, url);
      if (!current())
        throw new Error("Browser navigation superseded or closed");
      Object.assign(this.browser(record.id), snapshot);
      this.store.schedulePersist();
      this.store.notify();
    } catch (error) {
      if (current()) {
        const target = this.browser(record.id);
        target.loading = false;
        target.error = error instanceof Error ? error.message : String(error);
        this.store.schedulePersist();
        this.store.notify();
      }
      throw error;
    }
  }
  removeBrowser(record: BrowserState): void {
    this.store.data.browsers = this.store.data.browsers.filter(
      (item) => item !== record,
    );
    this.browserLoads.delete(record.id);
    this.browserAdmissions.get(record.id)?.abort();
    this.browserAdmissions.delete(record.id);
    if (record.agentPage) this.agentPages?.close(record.id);
    else this.browserService?.close(record.id);
    const workspace = this.store.data.workspaces.find(
      (item) => item.id === record.workspaceId,
    );
    if (!workspace) return;
    workspace.panes = workspace.panes.filter(
      (item) => item.id !== record.paneId,
    );
    workspace.layout = removeLeaf(workspace.layout, record.paneId) ?? leaf("");
    if (!workspace.panes.length) {
      const pane = {
        id: randomUUID(),
        kind: "document",
        draftChat: true,
      } as const;
      workspace.panes.push(pane);
      workspace.layout = leaf(pane.id);
    }
    if (workspace.activePaneId === record.paneId)
      workspace.activePaneId = firstPane(workspace.layout);
  }
  browserEvent(event: BrowserEvent): void {
    const record = this.store.data.browsers.find(
      (item) => item.id === event.id,
    );
    if (!record || this.store.closing) return;
    if (event.type === "changed") {
      const url =
        event.snapshot.url &&
        !(
          event.snapshot.url === "about:blank" &&
          this.browserInitializations.has(record.id)
        )
          ? event.snapshot.url
          : record.url;
      Object.assign(record, event.snapshot, { url });
      this.store.schedulePersist();
      this.store.notify();
    } else if (event.type === "download") {
      record.download = {
        basename: event.basename,
        status: event.status,
        ...(event.path ? { path: event.path } : {}),
      };
      this.store.notify();
    }
  }

  synchronizeNativeViews(): void {
    for (const browser of this.store.data.browsers)
      browser.addons = this.browserAddons?.status(browser.url);
    if (this.browserService)
      for (const item of this.browserService.list()) {
        if (
          item.visible &&
          item.workspaceId !== this.store.data.activeWorkspaceId
        )
          this.browserService.setVisible(item.id, false);
      }
    for (const item of this.agentPages?.list() ?? [])
      if (
        item.visible &&
        item.workspaceId !== this.store.data.activeWorkspaceId
      )
        this.agentPages?.setVisible(item.id, false);
  }

  finishPage(
    request: OperationRequest,
    conversationId: string,
    status: "completed" | "uncertain",
  ): void {
    if (typeof request.pageId !== "string") return;
    const browser = this.store.data.browsers.find(
      (item) => item.id === request.pageId,
    );
    if (
      browser?.agentPage?.submission &&
      browser.agentPage.submission.id === request.submissionId &&
      browser.agentPage.conversationId === conversationId
    ) {
      browser.agentPage.submission.status = status;
      if (
        !this.store.closing &&
        this.agentPages?.list().some((page) => page.id === browser.id)
      )
        this.agentPages.setSubmissionState(browser.id, status);
      this.store.notify();
    }
  }

  async handle(
    request: OperationRequest,
    _trustedUi = false,
  ): Promise<unknown> {
    switch (request.op) {
      case "browser.default-status":
        return {
          available: app.isPackaged,
          http: app.isDefaultProtocolClient("http"),
          https: app.isDefaultProtocolClient("https"),
          ...(!app.isPackaged
            ? {
                reason:
                  "Default browser registration requires the packaged Cod application",
              }
            : {}),
        };

      case "browser.register-default":
        if (!app.isPackaged)
          throw new Error(
            "Default browser registration requires the packaged Cod application",
          );
        return {
          requested: {
            http: app.setAsDefaultProtocolClient("http"),
            https: app.setAsDefaultProtocolClient("https"),
          },
          current: {
            http: app.isDefaultProtocolClient("http"),
            https: app.isDefaultProtocolClient("https"),
          },
        };

      case "page.open":
        return this.openAgentPage(request);

      case "browser.open":
        return this.openBrowser(request);

      case "browser.navigate":
        return this.navigateBrowser(
          requiredString(request, "id"),
          requiredString(request, "url"),
        );

      case "browser.diagnostics": {
        const id = requiredString(request, "id");
        const record = this.browser(id);
        const action = requiredString(request, "action");
        if (action !== "start" && action !== "read" && action !== "stop")
          throw new Error("Diagnostics action must be start, read or stop");
        if (record.agentPage || !this.browserService)
          throw new Error("Diagnostics require an external browser view");
        return this.browserService.diagnostics(id, action);
      }

      case "browser.blocking-retry": {
        const id = requiredString(request, "id");
        this.browser(id);
        if (!this.browserAddons) throw new Error("Browser add-ons unavailable");
        await this.browserAddons.retryBlocking();
        return structuredClone(this.browser(id));
      }

      case "browser.blocking": {
        const browser = this.browser(requiredString(request, "id"));
        if (
          ![true, false, "true", "false"].includes(
            request.enabled as boolean | string,
          )
        )
          throw new Error("enabled must be true or false");
        await this.toggleBlocking(
          browser.id,
          request.enabled === true || request.enabled === "true",
        );
        return structuredClone(this.browser(browser.id));
      }

      case "browser.inspect":
        return structuredClone(this.browser(requiredString(request, "id")));

      case "browser.close":
        return this.store.change(() => {
          const record = this.browser(requiredString(request, "id"));
          this.removeBrowser(record);
          return { id: record.id };
        });

      case "browser.recover": {
        const id = requiredString(request, "id");
        if (this.browser(id).agentPage)
          throw new Error(
            "Registered agent pages cannot recover browser navigation",
          );
        await this.requireBrowserService().recover(id);
        return { id };
      }

      case "browser.back":

      case "browser.forward":

      case "browser.reload": {
        const id = requiredString(request, "id");
        this.browser(id);
        const service = this.requireBrowserService();
        if (request.op === "browser.back") service.back(id);
        else if (request.op === "browser.forward") service.forward(id);
        else if (!service.list().some((item) => item.id === id))
          return this.navigateBrowser(id, this.browser(id).url);
        else service.reload(id);
        return { id };
      }

      default:
        throw new Error("Unknown browser operation");
    }
  }

  restoreSubmissions(): void {
    for (const browser of this.store.data.browsers)
      if (browser.agentPage?.submission?.status === "sending")
        browser.agentPage.submission.status = "uncertain";
  }
}
