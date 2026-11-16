import { SitePermissions, webOrigin } from "../browser/permissions";
import {
  sitePermissionNames,
  type SitePolicy,
  type SitePermission,
} from "../browser/permission-types";
import { BrowserLibrary } from "../browser/library";
import { normalizeNavigation } from "../browser/navigation";
import { readFileSync } from "node:fs";
import { resolveAddress } from "../browser/address";
import {
  findFocusWorld,
  captureFindFocus,
  restoreFindFocus,
} from "../browser/find-focus";
import { nativeKeyInput, resolveKeybinding } from "../keyboard";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { app, shell, type BrowserWindow, type Session } from "electron";
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
  private sitePermissions?: SitePermissions;
  private readonly library: BrowserLibrary;
  private readonly recordedPages = new Map<string, string>();
  private libraryError?: Error;
  private browserService?: BrowserService;
  private agentPages?: AgentPageService;
  private browserAddons?: BrowserAddons;
  private selectedBrowserContents?: number;
  private synchronizingBrowserSelection = false;
  private findRevisions = new Map<string, number>();
  private browserLoads = new Map<string, number>();
  private browserAdmissions = new Map<string, AbortController>();
  private browserInitializations = new Map<string, Promise<unknown>>();
  private browserWindow?: BrowserWindow;
  constructor(
    private readonly store: ApplicationStateStore,
    private readonly conversations: BrowserConversationPort,
  ) {
    this.library = new BrowserLibrary(store.directory);
  }
  diagnosticContext(contentsId: number) {
    const page = this.agentPages?.diagnosticContext(contentsId);
    if (page) return { ...page, role: "agent-page" };
    const browser = this.browserService?.diagnosticContext(contentsId);
    if (browser) return { ...browser, role: "browser" };
    return undefined;
  }
  async toggleBlocking(id: string, enabled: boolean): Promise<void> {
    if (!this.browserAddons) throw new Error("Browser add-ons unavailable");
    await this.browserAddons.toggle(this.browser(id).url, enabled);
    const service = this.requireBrowserService();
    if (service.list().some((view) => view.id === id)) service.reload(id);
  }
  async shutdown(): Promise<void> {
    for (const controller of this.browserAdmissions.values())
      controller.abort();
    this.browserAdmissions.clear();
    this.sitePermissions?.dispose();
    this.browserAddons?.dispose();
    this.browserService?.dispose();
    this.agentPages?.dispose();
    await this.library.flush();
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
    contents.on("focus", () => this.syncNativeFocus(contents, record.id));
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
    this.sitePermissions = new SitePermissions({
      session,
      owner: (contents) => this.browserService?.owner(contents.id),
      policies: () => this.store.data.sitePermissions ?? [],
      save: (policy) => this.saveSitePolicy(policy),
      changed: (pending) => {
        for (const browser of this.store.data.browsers)
          browser.permissionRequests = pending.filter(
            (item) => item.browserId === browser.id,
          );
        this.store.notify();
      },
      denied: (id, permission) => this.browserPermissionDenied(id, permission),
    });
    const browserForContents = (contents: import("electron").WebContents) =>
      this.store.data.browsers.find((item) => item.nativeTabId === contents.id);
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
        // Shutdown destroys native views but must retain their persisted tabs.
        if (this.store.closing) return;
        const browser = browserForContents(contents);
        if (browser)
          void this.store
            .change(async () => {
              if (
                !this.store.closing &&
                !this.isPinned(browser) &&
                (await this.requestClose(browser))
              )
                this.removeBrowser(browser);
            })
            .catch(() => undefined);
      },
    });
    this.browserService = new BrowserService({
      scrollbarCSS: readFileSync(
        path.join(__dirname, "scrollbars.css"),
        "utf8",
      ),
      isAllowedExtensionUrl: (url) => this.browserAddons?.allows(url) ?? false,
      window,
      session,
      downloadDirectory,
      onTabCreated: (tab, openerId, background) => {
        // Chromium needs a WebContents synchronously to preserve opener/POST.
        // Admit its metadata through the same serialized durable mutation as UI operations.
        void this.store
          .change(() => {
            if (this.store.closing) throw new Error("Cod is shutting down");
            const opener = this.browser(openerId);
            const workspace = this.store.workspace(opener.workspaceId);
            const contents = this.browserService?.getWebContents(tab.id);
            if (!contents || contents.isDestroyed())
              throw new Error("New tab already closed");
            const paneId = randomUUID();
            const snapshot = this.requireBrowserService().snapshot(tab.id);
            const record: BrowserState = {
              ...tab,
              ...snapshot,
              url: snapshot.url || tab.url,
              paneId,
              nativeTabId: contents.id,
              addons: this.browserAddons?.status(tab.url),
            };
            workspace.panes.push({
              id: paneId,
              kind: "browser",
              browserId: record.id,
            });
            const group = workspace.groups?.find((item) =>
              item.paneIds.includes(opener.paneId),
            );
            if (group)
              group.paneIds.splice(
                group.paneIds.indexOf(opener.paneId) + 1,
                0,
                paneId,
              );
            if (
              !background &&
              workspace.activePaneId === opener.paneId &&
              workspace.id === this.store.data.activeWorkspaceId
            )
              workspace.activePaneId = paneId;
            this.store.data.browsers.push(record);
            return record;
          })
          .catch(() => this.browserService?.close(tab.id));
      },
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
          if (contents.isDestroyed() || !contents.isFocused()) return;
          const browser = this.store.data.browsers.find(
            (item) => item.id === id,
          );
          if (browser?.workspaceId !== this.store.data.activeWorkspaceId)
            return;
          this.selectBrowserContents(contents);
          this.syncNativeFocus(contents, id);
        });
        this.routeNativeKeys(contents, id, "browser");
      },
    });
    this.browserService.onEvent((event) => this.browserEvent(event));
  }
  private syncNativeFocus(contents: Electron.WebContents, id: string): void {
    if (contents.isDestroyed() || !contents.isFocused() || this.store.closing)
      return;
    const current = this.store.data.browsers.find((item) => item.id === id);
    const owner = this.store.data.workspaces.find(
      (item) => item.id === current?.workspaceId,
    );
    if (
      !current ||
      owner?.id !== this.store.data.activeWorkspaceId ||
      owner.activePaneId === current.paneId
    )
      return;
    void this.store
      .change(() => {
        // Focus notifications may wait behind persistence or another operation.
        // A view that has since blurred must not undo explicit pane navigation.
        if (
          contents.isDestroyed() ||
          !contents.isFocused() ||
          this.store.closing
        )
          return;
        const browser = this.store.data.browsers.find((item) => item.id === id);
        const workspace = this.store.data.workspaces.find(
          (item) =>
            item.id === browser?.workspaceId &&
            item.id === this.store.data.activeWorkspaceId,
        );
        if (
          workspace &&
          browser &&
          workspace.panes.some((pane) => pane.id === browser.paneId)
        )
          workspace.activePaneId = browser.paneId;
      })
      .catch(() => undefined);
  }

  private routeNativeKeys(
    contents: Electron.WebContents,
    id: string,
    surface: "browser" | "agent-page",
  ): void {
    contents.on("found-in-page", (_event, result) => {
      this.browserWindow?.webContents.send("cod:browser-find", {
        browserId: id,
        requestId: result.requestId,
        matches: result.matches,
        activeMatchOrdinal: result.activeMatchOrdinal,
        finalUpdate: result.finalUpdate,
      });
    });
    contents.on("before-input-event", (event, input) => {
      const match = resolveKeybinding(
        nativeKeyInput(input),
        process.platform === "darwin" ? "darwin" : "linux",
        surface,
      );
      if (!match) return;
      event.preventDefault();
      if (!match.dispatch) return;
      // Hiding a pane chooses its replacement after layout is committed. Moving
      // native focus first can revive a stale editor and echo pane.focus back,
      // racing the hide and reopening the pane that was just hidden.
      if (
        match.command !== "pane.toggleLeft" &&
        match.command !== "pane.toggleRight"
      )
        this.browserWindow?.webContents.focus();
      this.browserWindow?.webContents.send("cod:command", {
        command: match.command,
        browserId: id,
      });
    });
  }

  async browserFind(
    id: string,
    text: string,
    options: { forward?: boolean; findNext?: boolean } = {},
  ): Promise<number> {
    const browser = this.browser(id);
    if (browser.workspaceId !== this.store.data.activeWorkspaceId)
      throw new Error("Search target is not in the active workspace");
    if (text.length > 10000) throw new Error("Search text is too long");
    const contents = browser.agentPage
      ? this.agentPages?.getWebContents(id)
      : this.browserService?.getWebContents(id);
    if (!contents || contents.isDestroyed())
      throw new Error("Search target is closed");
    if (!text) {
      contents.stopFindInPage("clearSelection");
      return 0;
    }
    const revision = (this.findRevisions.get(id) ?? 0) + 1;
    this.findRevisions.set(id, revision);
    await contents.executeJavaScriptInIsolatedWorld(findFocusWorld, [
      { code: captureFindFocus },
    ]);
    if (
      this.findRevisions.get(id) !== revision ||
      contents.isDestroyed() ||
      this.store.closing
    )
      return 0;
    return contents.findInPage(text, {
      forward: options.forward ?? true,
      findNext: options.findNext ?? false,
    });
  }
  browserStopFind(id: string): void {
    // Renderer teardown may arrive after native resources were disposed. Clearing
    // transient search selection is best-effort and must never block app exit.
    this.findRevisions.set(id, (this.findRevisions.get(id) ?? 0) + 1);
    if (this.store.closing) return;
    const browser = this.store.data.browsers.find((item) => item.id === id);
    if (!browser || browser.workspaceId !== this.store.data.activeWorkspaceId)
      return;
    try {
      const contents = browser.agentPage
        ? this.agentPages?.getWebContents(id)
        : this.browserService?.getWebContents(id);
      if (contents && !contents.isDestroyed()) {
        contents.stopFindInPage("clearSelection");
        void contents
          .executeJavaScriptInIsolatedWorld(findFocusWorld, [
            { code: restoreFindFocus },
          ])
          .catch(() => undefined);
      }
    } catch {
      // The tab may have closed between the renderer's dismiss and this IPC.
    }
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
    const [width, height] = window.getContentSize();
    // A restored record is inert until an actual visible viewport requests it.
    // Existing views stay alive across workspace switches to retain forms/media.
    for (const rect of rectangles) {
      if (
        !rect ||
        ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.width < 1 ||
        rect.height < 1 ||
        rect.x + rect.width > width + 1 ||
        rect.y + rect.height > height + 1
      )
        continue;
      const record = this.store.data.browsers.find(
        (item) =>
          item.id === rect.id &&
          item.workspaceId === active?.id &&
          !item.agentPage,
      );
      if (
        record &&
        !service.list().some((item) => item.id === record.id) &&
        !this.browserInitializations.has(record.id)
      )
        void this.restoreBrowser(record).catch(() => undefined);
    }
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
      !["http:", "https:", "file:"].includes(parsed.protocol) &&
      parsed.href !== "about:blank"
    )
      throw new Error("Unsupported browser URL protocol");
    if (parsed.protocol === "file:" && parsed.host)
      throw new Error("Only local file addresses are supported");
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
        active = this.store.openingPane(workspace, request);
      const paneId =
        (active.kind === "document" && !active.filePath && !active.draftChat) ||
        (active.kind === "empty" && active.launcher)
          ? active.id
          : randomUUID();
      if (paneId === active.id)
        workspace.panes[workspace.panes.indexOf(active)] = {
          id: paneId,
          pinned: active.pinned,
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
    const pending = this.browserInitializations.get(record.id);
    if (pending) {
      await pending;
      return;
    }
    if (!record.error)
      return this.loadBrowser(record, record.url, record.navigation);
    const restoredFailure = {
      url: record.url,
      error: record.error,
      title: record.title,
      lastSuccessfulUrl: record.lastSuccessfulUrl,
      navigation: record.navigation,
    };
    const initialization = this.requireBrowserService().open({
      id: record.id,
      workspaceId: record.workspaceId,
      url: "about:blank",
      restoredFailure,
    });
    this.browserInitializations.set(record.id, initialization);
    try {
      const snapshot = await initialization;
      Object.assign(record, snapshot);
      this.store.schedulePersist();
      this.store.notify();
    } finally {
      if (this.browserInitializations.get(record.id) === initialization)
        this.browserInitializations.delete(record.id);
    }
  }
  async navigateBrowser(id: string, url: string): Promise<BrowserState> {
    const record = this.browser(id);
    if (record.agentPage)
      throw new Error("Registered agent pages cannot navigate to other sites");
    await this.loadBrowser(
      record,
      this.browserUrl(
        resolveAddress(url, (await this.library.settings()).searchEngine),
      ),
    );
    return structuredClone(this.browser(id));
  }
  async loadBrowser(
    record: BrowserState,
    url: string,
    navigation?: import("../browser/navigation").BrowserNavigation,
  ): Promise<void> {
    const service = this.requireBrowserService();
    const savedNavigation = normalizeNavigation(navigation);
    const restore =
      savedNavigation?.entries[savedNavigation.index]?.url === url &&
      !service.list().some((item) => item.id === record.id)
        ? savedNavigation
        : undefined;
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
          deferNavigation: Boolean(restore),
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
      const snapshot = restore
        ? await service.restoreNavigation(record.id, restore)
        : await service.navigate(record.id, url);
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
  private isPinned(record: BrowserState): boolean {
    return !!this.store.data.workspaces
      .find((workspace) => workspace.id === record.workspaceId)
      ?.panes.find((pane) => pane.id === record.paneId)?.pinned;
  }
  async requestClose(record: BrowserState): Promise<boolean> {
    if (this.store.closing) return false;
    if (record.agentPage) return true;
    const closed = (await this.browserService?.requestClose(record.id)) ?? true;
    return closed && !this.store.closing;
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
    if (event.type === "download") {
      if (this.store.closing && event.download.status === "cancelled")
        event.download.status = "interrupted";
      const downloads = (this.store.data.browserDownloads ??= []);
      const previous = downloads.find((item) => item.id === event.download.id);
      if (previous) Object.assign(previous, event.download);
      else downloads.unshift(event.download);
      this.store.data.browserDownloads = downloads.filter(
        (item, index) =>
          index < 200 || ["progressing", "paused"].includes(item.status),
      );
      this.store.schedulePersist();
      this.store.notify(true);
      return;
    }
    const record = this.store.data.browsers.find(
      (item) => item.id === event.id,
    );
    if (!record || this.store.closing) return;
    if (event.type === "closed") {
      void this.store
        .change(() => {
          if (
            !this.store.closing &&
            this.store.data.browsers.includes(record)
          ) {
            if (this.isPinned(record)) {
              record.visible = false;
              record.loading = false;
              record.error =
                "The page closed itself. Reload to open this pinned tab again.";
            } else this.removeBrowser(record);
          }
        })
        .catch(() => undefined);
      return;
    }
    if (event.type === "changed") {
      if (
        this.browserInitializations.has(record.id) &&
        record.error &&
        !event.snapshot.error
      )
        return;
      const url =
        event.snapshot.url &&
        !(
          event.snapshot.url === "about:blank" &&
          this.browserInitializations.has(record.id)
        )
          ? event.snapshot.url
          : record.url;
      Object.assign(record, event.snapshot, { url });
      const key = `${url}\n${record.title}`;
      if (
        !record.agentPage &&
        !record.loading &&
        !record.error &&
        /^https?:/.test(url) &&
        record.lastSuccessfulUrl === url &&
        this.recordedPages.get(record.id) !== key
      ) {
        this.recordedPages.set(record.id, key);
        void this.library.visit(url, record.title).catch((error) => {
          this.libraryError = error;
        });
      }
      this.store.schedulePersist();
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

  private async saveSitePolicy(policy: SitePolicy): Promise<void> {
    await this.store.change(() => {
      const policies = (this.store.data.sitePermissions ??= []);
      const index = policies.findIndex(
        (item) =>
          item.origin === policy.origin &&
          item.topOrigin === policy.topOrigin &&
          item.permission === policy.permission,
      );
      if (index >= 0) policies[index] = policy;
      else policies.push(policy);
    });
  }
  async handle(
    request: OperationRequest,
    _trustedUi = false,
  ): Promise<unknown> {
    switch (request.op) {
      case "browser.downloads":
        return structuredClone(this.store.data.browserDownloads ?? []);
      case "browser.download-action": {
        const id = requiredString(request, "id"),
          action = requiredString(request, "action");
        const item = this.store.data.browserDownloads?.find(
          (item) => item.id === id,
        );
        if (!item) throw new Error("Download not found");
        if (["pause", "resume", "cancel"].includes(action)) {
          this.requireBrowserService().controlDownload(
            id,
            action as "pause" | "resume" | "cancel",
          );
        } else if (action === "retry") {
          if (!["interrupted", "cancelled"].includes(item.status))
            throw new Error("Download is not interrupted");
          this.requireBrowserService().retryDownload(item.url);
        } else if (action === "remove") {
          if (["progressing", "paused"].includes(item.status))
            throw new Error("Cancel the active download first");
          return this.store.change(() => {
            this.store.data.browserDownloads =
              this.store.data.browserDownloads?.filter(
                (item) => item.id !== id,
              );
          });
        } else if (action === "open" || action === "reveal") {
          if (item.status !== "completed" || !item.path)
            throw new Error("Download has not completed");
          if (action === "reveal") shell.showItemInFolder(item.path);
          else {
            const error = await shell.openPath(item.path);
            if (error) throw new Error(error);
          }
        } else throw new Error("Unknown download action");
        return { id, action };
      }
      case "browser.permissions":
        return structuredClone(this.store.data.sitePermissions ?? []);
      case "browser.permission-answer":
        if (!this.sitePermissions)
          throw new Error("Browser permissions unavailable");
        return this.sitePermissions.answer(
          requiredString(request, "requestId"),
          requiredString(request, "decision"),
        );
      case "browser.permission-set": {
        const origin = webOrigin(requiredString(request, "origin")),
          topOrigin = webOrigin(
            typeof request.topOrigin === "string" ? request.topOrigin : origin,
          );
        const permission = requiredString(
          request,
          "permission",
        ) as SitePermission;
        const decision = requiredString(request, "decision");
        if (
          !Object.hasOwn(sitePermissionNames, permission) ||
          !["allow", "block", "ask"].includes(decision)
        )
          throw new Error("Unsupported site permission or decision");
        this.sitePermissions?.revoke(origin, topOrigin, permission);
        if (decision === "ask")
          await this.store.change(() => {
            this.store.data.sitePermissions = (
              this.store.data.sitePermissions ?? []
            ).filter(
              (item) =>
                !(
                  item.origin === origin &&
                  item.topOrigin === topOrigin &&
                  item.permission === permission
                ),
            );
          });
        else
          await this.saveSitePolicy({
            origin,
            topOrigin,
            permission,
            decision: decision as "allow" | "block",
          });
        return { saved: true };
      }
      case "browser.bookmarks":
        return this.library.bookmarks(
          typeof request.query === "string" ? request.query : "",
        );
      case "browser.bookmark":
        return this.library.bookmark(
          requiredString(request, "url"),
          typeof request.title === "string" ? request.title : "",
          typeof request.id === "string" ? request.id : undefined,
        );
      case "browser.bookmark-delete":
        return this.library.removeBookmark(requiredString(request, "id"));
      case "browser.settings":
        return typeof request.searchEngine === "string"
          ? this.library.configure(request.searchEngine)
          : this.library.settings();
      case "browser.history":
        if (this.libraryError) throw this.libraryError;
        return this.library.history(
          typeof request.query === "string" ? request.query : "",
          Number(request.limit ?? 100),
        );
      case "browser.history-delete":
        return this.library.forget(requiredString(request, "url"));
      case "browser.history-clear":
        return this.library.forget();
      case "browser.suggest": {
        const query =
          typeof request.query === "string" ? request.query.trim() : "";
        const matches = (this.store.data.pinnedSites ?? []).filter((item) =>
          `${item.title} ${item.url}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
        );
        const bookmarks = await this.library.bookmarks(query);
        for (const item of bookmarks)
          if (!matches.some((pin) => pin.url === item.url)) matches.push(item);
        const history = await this.library.history(query, 8);
        return [
          ...matches,
          ...history.filter(
            (item) => !matches.some((pin) => pin.url === item.url),
          ),
        ].slice(0, 8);
      }
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

      case "browser.pin":
      case "browser.unpin":
        return this.store.change(() => {
          const url = this.browserUrl(requiredString(request, "url"));
          if (url === "about:blank") throw new Error("Choose a website to pin");
          const sites = (this.store.data.pinnedSites ??= []);
          const index = sites.findIndex((site) => site.url === url);
          if (request.op === "browser.unpin") {
            if (index >= 0) sites.splice(index, 1);
          } else {
            const title =
              typeof request.title === "string" && request.title.trim()
                ? request.title.trim()
                : new URL(url).hostname;
            const site = { url, title };
            if (index >= 0) sites[index] = site;
            else sites.push(site);
          }
          return structuredClone(sites);
        });

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
        if (!this.browserService.list().some((view) => view.id === id)) {
          if (action === "start" && record.error)
            await this.restoreBrowser(record);
          else
            throw new Error("Open the browser tab before starting diagnostics");
        }
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

      case "browser.recover": {
        const id = requiredString(request, "id");
        await this.browserInitializations.get(id);
        if (this.browser(id).agentPage)
          throw new Error(
            "Registered agent pages cannot recover browser navigation",
          );
        if (
          !this.requireBrowserService()
            .list()
            .some((view) => view.id === id)
        )
          await this.restoreBrowser(this.browser(id));
        await this.requireBrowserService().recover(id);
        return { id };
      }

      case "browser.back":

      case "browser.forward":

      case "browser.reload": {
        const id = requiredString(request, "id");
        const browser = this.browser(id);
        await this.browserInitializations.get(id);
        if (browser.agentPage) {
          const contents = this.agentPages?.getWebContents(id);
          if (!contents || contents.isDestroyed())
            throw new Error("Agent page is not loaded");
          if (
            request.op === "browser.back" &&
            contents.navigationHistory.canGoBack()
          )
            contents.navigationHistory.goBack();
          else if (
            request.op === "browser.forward" &&
            contents.navigationHistory.canGoForward()
          )
            contents.navigationHistory.goForward();
          else if (request.op === "browser.reload") contents.reload();
          return { id };
        }
        const service = this.requireBrowserService();
        if (!service.list().some((item) => item.id === id)) {
          if (request.op === "browser.reload" && !browser.error)
            return this.navigateBrowser(id, browser.url);
          await this.restoreBrowser(browser);
        }
        if (request.op === "browser.back") service.back(id);
        else if (request.op === "browser.forward") service.forward(id);
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
