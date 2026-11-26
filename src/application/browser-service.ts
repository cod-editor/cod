import { normalizeGroups } from "../workspace-layout";
import { toggleDevTools } from "../devtools";
import { SitePermissions, webOrigin } from "../browser/permissions";
import {
  sitePermissionNames,
  type SitePolicy,
  type SitePermission,
} from "../browser/permission-types";
import { BrowserLibrary } from "../browser/library";
import { BrowserAddressOverlay } from "../browser/address-overlay";
import { downloadRows } from "../browser/download-presentation";
import { isBrowserFailure, isBrowserHome } from "../browser/view-state";
import { normalizeNavigation } from "../browser/navigation";
import { readFileSync } from "node:fs";
import {
  resolveAddress,
  searchAddress,
  webUrl,
  contextLinkUrl,
} from "../browser/address";
import { eligibleSearchPhrase } from "../browser/search-query";
import { googleSearchSuggestions } from "../browser/search-suggestions";
import {
  findFocusWorld,
  captureFindFocus,
  restoreFindFocus,
} from "../browser/find-focus";
import { isPlainEscape, nativeKeyInput, resolveKeybinding } from "../keyboard";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { app, shell, type BrowserWindow, type Session } from "electron";
import { BrowserService, type BrowserEvent } from "../browser";
import type { CertificateIdentity } from "../browser/temporary-certificate";
import { faviconOrigin } from "../browser/favicon-origin";
import { AgentPageService, resolveAgentPageFile } from "../agent-pages";
import { BrowserAddons } from "../browser-addons";
import type {
  BrowserState,
  BrowserLayout,
  BrowserRectangle,
  BrowserModalCover,
  OperationRequest,
} from "../types";
import { ApplicationStateStore } from "./state";
import { requiredString } from "./request";
const siteZoomSteps = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
];

export interface BrowserConversationPort {
  isActive(id: string): boolean;
  send(request: OperationRequest): Promise<{ id: string; status: string }>;
}
export class BrowserApplicationService {
  private sitePermissions?: SitePermissions;
  private readonly library: BrowserLibrary;
  private suggestionRequest?: AbortController;
  private readonly recordedPages = new Map<string, string>();
  private libraryError?: Error;
  private browserService?: BrowserService;
  private agentPages?: AgentPageService;
  private agentPageOpens = new Map<
    string,
    Promise<{ id: string; paneId: string }>
  >();
  private browserAddons?: BrowserAddons;
  private selectedBrowserContents?: number;
  private synchronizingBrowserSelection = false;
  private activeFindBrowserId?: string;
  private findRevisions = new Map<string, number>();
  private browserLoads = new Map<string, number>();
  private browserAdmissions = new Map<string, AbortController>();
  private browserInitializations = new Map<string, Promise<unknown>>();
  private browserWindow?: BrowserWindow;
  private addressOverlay?: BrowserAddressOverlay;
  private modalPresentation?: {
    opening: number;
    workspace: string;
    covered?: Set<string>;
  };
  private readonly modalCaptures = new Set<string>();
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
    this.suggestionRequest?.abort();
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
      openLink: (id, url) => this.openLink(id, url),
      openExternal: (url) => this.openExternal(url),
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
    const pending = this.browserInitializations.get(record.id);
    if (pending) {
      await pending;
      return;
    }
    if (this.agentPages?.has(record.id)) return;
    const initialization = this.initializeAgentPage(record);
    this.browserInitializations.set(record.id, initialization);
    try {
      await initialization;
    } finally {
      this.browserInitializations.delete(record.id);
    }
  }

  private async initializeAgentPage(record: BrowserState): Promise<void> {
    if (!this.agentPages || !record.agentPage)
      throw new Error("Agent page host unavailable");
    const page = await this.agentPages.open({
      id: record.id,
      workspaceId: record.workspaceId,
      conversationId: record.agentPage.conversationId,
      path: record.agentPage.path,
    });
    record.url = page.url;
    record.error = undefined;
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

  private agentPageWorkspace(workspaceId: string, conversationId: string) {
    const workspace = this.store.workspace(workspaceId);
    if (this.store.conversation(conversationId).workspaceId !== workspaceId)
      throw new Error("Page origin must belong to workspace");
    return workspace;
  }

  async openAgentPage(
    request: OperationRequest,
  ): Promise<{ id: string; paneId: string }> {
    const workspaceId = requiredString(request, "workspace");
    const conversationId = requiredString(request, "conversation");
    const refresh = request.refresh;
    if (
      refresh !== undefined &&
      refresh !== true &&
      refresh !== false &&
      refresh !== "true" &&
      refresh !== "false"
    )
      throw new Error("refresh must be true or false");
    this.agentPageWorkspace(workspaceId, conversationId);
    const filePath = await resolveAgentPageFile(
      requiredString(request, "path"),
    );
    const identity = JSON.stringify([workspaceId, conversationId, filePath]);
    const previous = this.agentPageOpens.get(identity);
    const opening = (
      previous?.catch(() => undefined) ?? Promise.resolve()
    ).then(() =>
      this.showAgentPage(
        workspaceId,
        conversationId,
        filePath,
        refresh === true || refresh === "true",
      ),
    );
    this.agentPageOpens.set(identity, opening);
    try {
      return await opening;
    } finally {
      if (this.agentPageOpens.get(identity) === opening)
        this.agentPageOpens.delete(identity);
    }
  }

  private async showAgentPage(
    workspaceId: string,
    conversationId: string,
    filePath: string,
    refresh: boolean,
  ): Promise<{ id: string; paneId: string }> {
    const workspace = this.agentPageWorkspace(workspaceId, conversationId);
    const matches = this.store.data.browsers.filter(
      (record) =>
        record.workspaceId === workspaceId &&
        record.agentPage?.conversationId === conversationId &&
        record.agentPage.path === filePath,
    );
    const existing =
      matches.find((record) => record.paneId === workspace.activePaneId) ??
      matches[0];
    if (existing) {
      const alreadyLoaded =
        this.agentPages?.has(existing.id) &&
        !this.browserInitializations.has(existing.id);
      await this.loadAgentPage(existing);
      if (refresh && alreadyLoaded) await this.agentPages!.refresh(existing.id);
      return this.store.changeLayout(() => {
        const workspace = this.agentPageWorkspace(workspaceId, conversationId);
        if (
          !this.store.data.browsers.includes(existing) ||
          !workspace.panes.some(
            (pane) =>
              pane.kind === "browser" &&
              pane.id === existing.paneId &&
              pane.browserId === existing.id,
          )
        )
          throw new Error("Registered page was closed while opening");
        this.store.data.activeWorkspaceId = workspaceId;
        workspace.activePaneId = existing.paneId;
        normalizeGroups(workspace);
        return { id: existing.id, paneId: existing.paneId };
      });
    }
    const id = randomUUID(),
      paneId = randomUUID();
    const record: BrowserState = {
      id,
      paneId,
      workspaceId,
      url: "",
      title: path.basename(filePath),
      loading: true,
      visible: false,
      canGoBack: false,
      canGoForward: false,
      agentPage: { path: filePath, conversationId },
    };
    await this.loadAgentPage(record);
    try {
      return await this.store.change(() => {
        const workspace = this.agentPageWorkspace(workspaceId, conversationId);
        workspace.panes.push({ id: paneId, kind: "browser", browserId: id });
        this.store.data.activeWorkspaceId = workspaceId;
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
    this.addressOverlay = new BrowserAddressOverlay(window, (id, action) =>
      this.handle({ op: "browser.download-action", id, action }),
    );
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
          { extension: true },
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
      hasHomePin: (origin) =>
        (this.store.data.pinnedSites ?? []).some(
          (site) => faviconOrigin(site.url) === origin,
        ),
      window,
      session,
      downloadDirectory,
      openLink: (id, url) => this.openLink(id, url),
      openExternal: (url) => this.openExternal(url),
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
            if (group) group.paneIds.push(paneId);
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
          if (contents.session === session)
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
  private syncNativeFocus(
    contents: Electron.WebContents,
    id: string,
    source: "focus" | "pointer" = "focus",
  ): void {
    if (this.modalPresentation !== undefined) {
      this.focusShellModal(this.modalPresentation.opening);
      return;
    }
    if (
      contents.isDestroyed() ||
      this.store.closing ||
      (source === "focus" && !contents.isFocused())
    )
      return;
    const current = this.store.data.browsers.find((item) => item.id === id);
    const owner = this.store.data.workspaces.find(
      (item) => item.id === current?.workspaceId,
    );
    if (source === "focus" && current && !current.visible) {
      // Chromium can focus a newly created hidden WebContents during navigation.
      // Wait until that native focus dispatch finishes, then restore the selected
      // surface only while the hidden contents still owns focus.
      setImmediate(() => {
        if (
          contents.isDestroyed() ||
          !contents.isFocused() ||
          this.store.closing
        )
          return;
        const hidden = this.store.data.browsers.find((b) => b.id === id);
        const active = this.store.data.workspaces.find(
          (w) => w.id === this.store.data.activeWorkspaceId,
        );
        if (!hidden || hidden.visible || active?.activePaneId === hidden.paneId)
          return;
        const selected = this.store.data.browsers.find(
          (b) =>
            b.workspaceId === active?.id && b.paneId === active?.activePaneId,
        );
        try {
          const target = selected?.visible
            ? selected.agentPage
              ? this.agentPages?.getWebContents(selected.id)
              : this.browserService?.getWebContents(selected.id)
            : this.browserWindow?.webContents;
          if (target && !target.isDestroyed()) target.focus();
        } catch {
          /* The selected native page closed during delivery. */
        }
      });
      return;
    }
    if (
      !current ||
      !current.visible ||
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
          this.store.closing ||
          this.modalPresentation ||
          (source === "focus" && !contents.isFocused())
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
          browser?.visible &&
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
    contents.on("before-mouse-event", (event, input) => {
      if (input.type === "mouseDown") this.addressOverlay?.dismiss();
      const modal = this.modalPresentation;
      if (modal) {
        event.preventDefault();
        if (input.type === "mouseDown" || input.type === "mouseUp")
          this.focusShellModal(modal.opening);
        return;
      }
      // Queue an actual press in event order. Chromium's focus notification
      // can be redundant or still pending when the visible page is clicked.
      if (input.type === "mouseDown")
        this.syncNativeFocus(contents, id, "pointer");
    });
    contents.on("before-input-event", (event, input) => {
      if (this.modalPresentation !== undefined) {
        event.preventDefault();
        return;
      }
      const key = nativeKeyInput(input);
      if (
        input.type === "keyDown" &&
        this.activeFindBrowserId === id &&
        isPlainEscape(key)
      ) {
        event.preventDefault();
        if (!input.isAutoRepeat)
          this.browserWindow?.webContents.send("cod:browser-find-dismiss", id);
        return;
      }
      const match = resolveKeybinding(
        key,
        process.platform === "darwin" ? "darwin" : "linux",
        surface,
      );
      if (!match) return;
      event.preventDefault();
      if (!match.dispatch) return;
      if (match.command === "devtools.toggle") {
        toggleDevTools(contents);
        return;
      }
      if (
        (match.command === "pane.next" || match.command === "pane.previous") &&
        !this.store.data.workspaces.some(
          (workspace) =>
            workspace.id === this.store.data.activeWorkspaceId &&
            workspace.groups.length > 1,
        )
      )
        return;
      // Hiding a pane chooses its replacement after layout is committed. Moving
      // native focus first can revive a stale editor and echo pane.focus back,
      // racing the hide and reopening the pane that was just hidden.
      // Reload and page zoom keep focus in the native web view.
      if (
        match.command !== "browser.reload" &&
        !match.command.startsWith("browser.zoom") &&
        match.command !== "pane.toggleLeft" &&
        match.command !== "pane.toggleRight" &&
        match.command !== "pane.zoom"
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
  browserFindVisibility(id: string, visible: boolean): void {
    if (!visible) {
      if (this.activeFindBrowserId === id) this.activeFindBrowserId = undefined;
      return;
    }
    if (
      this.store.data.browsers.some(
        (browser) =>
          browser.id === id &&
          browser.workspaceId === this.store.data.activeWorkspaceId,
      )
    ) {
      this.activeFindBrowserId = id;
    }
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

  browserDevTools(id: string): void {
    const browser = this.browser(id);
    if (browser.workspaceId !== this.store.data.activeWorkspaceId)
      throw new Error("The inspected page is not in the current workspace");
    const contents = browser.agentPage
      ? this.agentPages?.getWebContents(id)
      : this.browserService?.getWebContents(id);
    if (!contents || contents.isDestroyed())
      throw new Error("The inspected page is no longer open");
    toggleDevTools(contents);
  }
  browserFocus(id: string): void {
    if (this.modalPresentation) return;
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

  private focusShellModal(opening: number): void {
    // Native click-to-focus may finish after the mouse/focus callback returns.
    setImmediate(() => {
      if (opening === this.modalPresentation?.opening)
        this.browserWindow?.webContents.focus();
    });
  }

  browserCoverModal(cover: BrowserModalCover): boolean {
    const modal = this.modalPresentation;
    if (
      cover.kind !== "shell-modal" ||
      !modal ||
      cover.opening !== modal.opening ||
      modal.workspace !== this.store.data.activeWorkspaceId
    )
      return false;
    // Layout continues to describe viewport geometry. Only the prepared
    // shell-modal handoff can suppress those viewports to show a backdrop.
    this.hideNativeViews((modal.covered ??= new Set()));
    return true;
  }

  clearBrowserPresentation(): void {
    this.modalPresentation = undefined;
    this.addressOverlay?.dismiss();
    this.hideNativeViews();
  }

  private hideNativeViews(covered?: Set<string>): void {
    for (const service of [this.browserService, this.agentPages]) {
      if (!service) continue;
      for (const item of service.list()) {
        if (!item.visible) continue;
        covered?.add(item.id);
        service.setVisible(item.id, false);
      }
    }
  }

  async browserPrepareModal(ids: unknown, opening: number) {
    const service = this.browserService;
    const workspace = this.store.data.activeWorkspaceId;
    if (
      !workspace ||
      this.store.closing ||
      !Array.isArray(ids) ||
      ids.length > 4 ||
      !ids.every((id) => typeof id === "string")
    )
      return [];
    this.addressOverlay?.dismiss();
    const modal = {
      opening,
      workspace,
      covered: this.modalPresentation?.covered,
    };
    this.modalPresentation = modal;
    this.browserWindow?.webContents.focus();
    if (!service) return [];
    const visible = new Set(
      service
        .list()
        .filter(
          (item) =>
            item.workspaceId === workspace && item.visible && !item.error,
        )
        .map((item) => item.id),
    );
    const captures: { id: string; url: string; bytes: Uint8Array }[] = [];
    const pending = Promise.all(
      [...new Set<string>(ids)]
        .filter((id) => visible.has(id) && !this.modalCaptures.has(id))
        .map(async (id) => {
          this.modalCaptures.add(id);
          try {
            const frame = await service.captureModalBackdrop(id);
            if (frame) captures.push({ id, ...frame });
          } catch {
            // A browser may close between checking visibility and capturing.
          } finally {
            this.modalCaptures.delete(id);
          }
        }),
    );
    // A stalled pane must not hold up a frame from a neighboring pane.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 50);
      }),
    ]);
    clearTimeout(timer);
    return this.modalPresentation === modal &&
      workspace === this.store.data.activeWorkspaceId &&
      !this.store.closing
      ? captures.slice()
      : [];
  }

  browserLayout({
    rectangles,
    popup,
    downloads,
    resumeModal,
  }: BrowserLayout): void {
    const closing =
      resumeModal !== undefined &&
      resumeModal === this.modalPresentation?.opening
        ? this.modalPresentation
        : undefined;
    if (closing) this.modalPresentation = undefined;
    const covered = this.modalPresentation?.covered;
    const service = this.browserService,
      window = this.browserWindow;
    if (!service || !window || window.isDestroyed()) return;
    const active = this.store.data.workspaces.find(
      (item) => item.id === this.store.data.activeWorkspaceId,
    );
    const visiblePanes = new Set(
      active?.groups
        ?.filter((group) => !group.hidden)
        .map((group) => group.activePaneId),
    );
    const hasViewport = (record: BrowserState) =>
      record.workspaceId === active?.id &&
      visiblePanes.has(record.paneId) &&
      !isBrowserFailure(record) &&
      !isBrowserHome(record);
    const [width, height] = window.getContentSize();
    const bounds = new Map(
      rectangles
        .filter(
          (rect) =>
            rect &&
            typeof rect.id === "string" &&
            [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
            rect.x >= 0 &&
            rect.y >= 0 &&
            rect.width >= 1 &&
            rect.height >= 1 &&
            rect.x + rect.width <= width + 1 &&
            rect.y + rect.height <= height + 1,
        )
        .map((rect) => [rect.id, rect]),
    );
    // A restored browser remains dormant until its selected pane reports bounds.
    for (const { id } of bounds.values()) {
      const record = this.store.data.browsers.find((item) => item.id === id);
      if (
        record &&
        hasViewport(record) &&
        !record.agentPage &&
        !service.list().some((item) => item.id === id) &&
        !this.browserInitializations.has(id)
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
          bounds.has(item.id),
      );
    if (browser && service.list().some((item) => item.id === browser.id)) {
      const contents = service.getWebContents(browser.id);
      if (contents.id !== this.selectedBrowserContents) {
        this.selectBrowserContents(contents);
      }
    }
    let popupSlot: BrowserRectangle | undefined;
    for (const item of [
      ...service.list(),
      ...(this.agentPages?.list() ?? []),
    ]) {
      const record = this.store.data.browsers.find(
        (browser) => browser.id === item.id,
      );
      if (!record) continue;
      const itemService = record.agentPage ? this.agentPages! : service;
      const rect = bounds.get(item.id);
      // Geometry can be late, including when returning from a modal. Preserve
      // the last native viewport of a selected page through either update.
      const visible =
        !covered &&
        hasViewport(record) &&
        (Boolean(rect) ||
          item.visible ||
          Boolean(closing?.covered?.has(item.id)));
      if (visible && rect) {
        itemService.setBounds(item.id, {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.max(1, Math.floor(rect.width)),
          height: Math.max(1, Math.floor(rect.height)),
        });
        if (popup?.id === item.id && !record.agentPage) popupSlot = rect;
      }
      if (item.visible !== visible) itemService.setVisible(item.id, visible);
    }
    const validOwner =
      popup &&
      typeof popup.id === "string" &&
      Number.isSafeInteger(popup.revision) &&
      this.modalPresentation === undefined &&
      this.store.data.browsers.some(
        (record) =>
          record.id === popup.id &&
          record.workspaceId === active?.id &&
          !record.agentPage,
      );
    const downloadRecord = this.store.data.browsers.find(
      ({ id }) => id === downloads?.id,
    );
    const slot = downloadRecord && bounds.get(downloadRecord.id);
    const panel = downloads?.bounds;
    const validDownloads =
      this.modalPresentation === undefined &&
      downloads &&
      downloadRecord &&
      !downloadRecord.agentPage &&
      hasViewport(downloadRecord) &&
      slot &&
      panel &&
      Number.isSafeInteger(downloads.revision) &&
      typeof downloads.fontSize === "string" &&
      downloads.fontSize.length <= 24 &&
      typeof downloads.fontFamily === "string" &&
      downloads.fontFamily.length <= 512 &&
      [panel.x, panel.y, panel.width, panel.height].every(Number.isInteger) &&
      panel.width > 0 &&
      panel.width <= 440 &&
      panel.height > 0 &&
      panel.height <= 360 &&
      panel.x >= slot.x - 1 &&
      panel.x + panel.width <= slot.x + slot.width + 1 &&
      panel.y >= 0 &&
      panel.y + panel.height <= Math.min(height + 1, slot.y + slot.height + 1);
    this.addressOverlay?.update(
      validOwner ? popup : undefined,
      popupSlot,
      validDownloads
        ? {
            popup: downloads,
            entries: downloadRows(this.store.data.browserDownloads ?? []),
          }
        : undefined,
    );
  }
  selectBrowserContents(contents: import("electron").WebContents): void {
    this.synchronizingBrowserSelection = true;
    try {
      if (!this.browserService?.isTemporaryContents(contents.id))
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
  async openExternal(url: string): Promise<{ url: string }> {
    const target = webUrl(url);
    if (app.isDefaultProtocolClient(new URL(target).protocol.slice(0, -1)))
      throw new Error(
        "Cod is the default browser for this link. Choose another system default browser to open it outside Cod.",
      );
    await shell.openExternal(target);
    return { url: target };
  }
  async openLink(id: string, value: string): Promise<BrowserState> {
    const source = this.browser(id);
    const url = contextLinkUrl(value, source.url);
    return this.openBrowser(
      { op: "browser.open", workspace: source.workspaceId, url },
      { source },
    );
  }

  async openBrowser(
    request: OperationRequest,
    {
      extension = false,
      source,
      focusHome = false,
      certificate,
    }: {
      extension?: boolean;
      source?: BrowserState;
      focusHome?: boolean;
      certificate?: CertificateIdentity;
    } = {},
  ): Promise<BrowserState> {
    const requested = requiredString(request, "url");
    const url =
      extension && this.browserAddons?.allows(requested)
        ? requested
        : this.browserUrl(requested);
    const record = await this.store.change(() => {
      this.requireBrowserService();
      const workspace = this.store.workspace(
        requiredString(request, "workspace"),
      );
      const beside = request.besideConversation !== undefined;
      const id = randomUUID();
      const active = beside
        ? undefined
        : source
          ? this.store.pane(workspace, source.paneId)
          : this.store.openingPane(workspace, request);
      const paneId =
        active &&
        !source &&
        request.sourcePane === undefined &&
        ((active.kind === "document" &&
          !active.filePath &&
          !active.draftChat) ||
          (active.kind === "empty" && active.launcher))
          ? active.id
          : randomUUID();
      if (beside)
        this.store.presentBesideConversation(workspace, request, {
          id: paneId,
          kind: "browser",
          browserId: id,
        });
      else if (request.sourcePane !== undefined)
        this.store.insertPane(
          workspace,
          { id: paneId, kind: "browser", browserId: id },
          request,
        );
      else if (active && paneId === active.id)
        workspace.panes[workspace.panes.indexOf(active)] = {
          id: paneId,
          pinned: active.pinned,
          kind: "browser",
          browserId: id,
        };
      else {
        workspace.panes.push({ id: paneId, kind: "browser", browserId: id });
        if (source && active) {
          const group = workspace.groups?.find((item) =>
            item.paneIds.includes(active.id),
          );
          if (!group) throw new Error("Source tab group no longer exists");
          group.paneIds.push(paneId);
        }
      }
      if (!beside && !source && request.sourcePane === undefined)
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
        addons: certificate ? undefined : this.browserAddons?.status(url),
        temporaryCertificate: certificate ? true : undefined,
      };
      this.store.data.browsers.push(record);
      return record;
    });
    const ready = this.loadBrowser(record, url, { certificate });
    // Home's address exists once the pane is admitted. Keep native loading
    // independent so only that foreground intent can focus the address.
    if (focusHome && url === "about:blank") void ready.catch(() => {});
    else await ready;
    return structuredClone(this.browser(record.id));
  }
  async withReopenedBrowser<T>(
    saved: BrowserState,
    commit: (browser: BrowserState) => Promise<T>,
  ): Promise<T> {
    const service = this.requireBrowserService();
    const { id, workspaceId } = saved;
    if (this.browserAdmissions.has(id))
      throw new Error("This browser tab is already being reopened");
    const admission = new AbortController();
    this.browserAdmissions.set(id, admission);
    const navigation = normalizeNavigation(saved.navigation);
    let prepared = false;
    try {
      // The native view stays hidden and the saved record stays untouched
      // until its pane and browser record can be published together.
      const snapshot = await service.open({
        id,
        workspaceId,
        url: saved.error ? "about:blank" : saved.url,
        ...(saved.error
          ? { restoredFailure: { ...saved, error: saved.error } }
          : {
              navigation:
                navigation?.entries[navigation.index]?.url === saved.url
                  ? navigation
                  : undefined,
              beforeNavigation: () =>
                this.browserAddons?.whenReady(admission.signal) ??
                Promise.resolve(),
            }),
      });
      prepared = true;
      if (this.store.closing) throw new Error("Cod is shutting down");
      return await commit({
        ...saved,
        ...snapshot,
        url: snapshot.url || saved.url,
        nativeTabId: service.getWebContents(id).id,
        httpFallback: undefined,
        permissionRequests: undefined,
        permissionDenied: undefined,
      });
    } catch (error) {
      if (prepared) service.close(id);
      throw error;
    } finally {
      if (this.browserAdmissions.get(id) === admission)
        this.browserAdmissions.delete(id);
    }
  }

  async restoreBrowser(record: BrowserState): Promise<void> {
    const pending = this.browserInitializations.get(record.id);
    if (pending) {
      await pending;
      return;
    }
    if (!record.error)
      return this.loadBrowser(record, record.url, {
        navigation: record.navigation,
      });
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
  async navigateBrowser(
    id: string,
    url: string,
    search = false,
  ): Promise<BrowserState> {
    const record = this.browser(id);
    if (record.agentPage)
      throw new Error("Registered agent pages cannot navigate to other sites");
    const { searchEngine } = await this.library.settings();
    const target = search
      ? { url: searchAddress(url, searchEngine) }
      : resolveAddress(url, searchEngine);
    await this.loadBrowser(record, this.browserUrl(target.url), {
      httpFallbackUrl: target.httpFallbackUrl,
    });
    return structuredClone(this.browser(id));
  }
  async loadBrowser(
    record: BrowserState,
    url: string,
    {
      navigation,
      httpFallbackUrl,
      replaceFailure,
      certificate,
    }: {
      navigation?: import("../browser/navigation").BrowserNavigation;
      httpFallbackUrl?: string;
      replaceFailure?: string;
      certificate?: CertificateIdentity;
    } = {},
  ): Promise<void> {
    const service = this.requireBrowserService();
    service.checkTemporaryNavigation(record.id, url);
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
    record.httpFallback = undefined;
    record.certificateOffer = undefined;
    record.permissionDenied = undefined;
    record.url = url;
    record.favicon = undefined;
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
          deferNavigation: Boolean(restore || certificate),
          certificate,
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
        : await service.navigate(record.id, url, replaceFailure);
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
        if (
          !restore &&
          !target.temporaryCertificate &&
          httpFallbackUrl &&
          service.httpsUnavailable(record.id, url)
        )
          target.httpFallback = { id: randomUUID(), url: httpFallbackUrl };
        this.store.schedulePersist();
        this.store.notify();
        if (target.httpFallback) return;
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
    if (this.activeFindBrowserId === record.id)
      this.activeFindBrowserId = undefined;
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
    if (!workspace.panes.length) {
      const pane = {
        id: randomUUID(),
        kind: "document",
        draftChat: true,
      } as const;
      workspace.panes.push(pane);
    }
    normalizeGroups(workspace);
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
              record.httpFallback = undefined;
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
      if (!event.snapshot.error || url !== record.url)
        record.httpFallback = undefined;
      Object.assign(record, event.snapshot, { url });
      if (
        !record.error &&
        !record.temporaryCertificate &&
        url === event.snapshot.url
      ) {
        const favoriteArt =
          this.browserService?.cachedSiteIcons(url)?.favoriteArt;
        const origin =
          record.favicon || favoriteArt ? faviconOrigin(url) : undefined;
        if (origin)
          for (const site of this.store.data.pinnedSites ?? []) {
            if (faviconOrigin(site.url) !== origin) continue;
            if (record.favicon) site.favicon = record.favicon;
            if (favoriteArt) site.favoriteArt = favoriteArt;
          }
      }
      const key = `${url}\n${record.title}`;
      if (
        !record.agentPage &&
        !record.temporaryCertificate &&
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
      // Native navigation emits several snapshots for URL, title, loading and
      // history changes. Publish the latest state once per existing UI batch.
      this.store.notify(true);
    }
  }

  synchronizeNativeViews(): void {
    for (const browser of this.store.data.browsers)
      browser.addons = browser.temporaryCertificate
        ? undefined
        : this.browserAddons?.status(browser.url);
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
  private async searchSuggestions(query: unknown): Promise<string[]> {
    this.suggestionRequest?.abort();
    this.suggestionRequest = undefined;
    if (typeof query !== "string" || !eligibleSearchPhrase(query)) return [];
    const pending = new AbortController();
    this.suggestionRequest = pending;
    try {
      const { searchEngine } = await this.library.settings();
      if (searchEngine !== "google" || pending.signal.aborted) return [];
      const terms = await googleSearchSuggestions(query, pending.signal);
      return pending.signal.aborted ? [] : terms;
    } catch {
      return [];
    } finally {
      if (this.suggestionRequest === pending)
        this.suggestionRequest = undefined;
    }
  }
  async handle(request: OperationRequest, trustedUi = false): Promise<unknown> {
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
        if (typeof request.searchEngine === "string") {
          this.suggestionRequest?.abort();
          return this.library.configure(request.searchEngine);
        }
        return this.library.settings();
      case "browser.search-suggestions":
        if (!trustedUi)
          throw new Error("Search suggestions require the desktop address bar");
        return this.searchSuggestions(request.query);
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
        const matches = (this.store.data.pinnedSites ?? [])
          .filter((item) =>
            `${item.title} ${item.url}`
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase()),
          )
          .map(({ title, url }) => ({ title, url }));
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

      case "browser.open-external":
        return this.openExternal(requiredString(request, "url"));
      case "browser.open-link":
        return this.openLink(
          requiredString(request, "id"),
          requiredString(request, "url"),
        );
      case "browser.open":
        return this.openBrowser(request, {
          focusHome: trustedUi && request.focus === true,
        });

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
            const icons = this.browserService?.cachedSiteIcons(url);
            const site = {
              url,
              title,
              favicon: icons?.favicon ?? sites[index]?.favicon,
              favoriteArt: icons?.favoriteArt ?? sites[index]?.favoriteArt,
            };
            if (index >= 0) sites[index] = site;
            else sites.push(site);
          }
          return structuredClone(sites);
        });

      case "browser.zoom": {
        const browser = this.browser(requiredString(request, "id"));
        const contents = this.browserService?.getWebContents(browser.id);
        if (
          browser.agentPage ||
          browser.error ||
          !contents ||
          contents.isDestroyed() ||
          !/^https?:\/\//i.test(contents.getURL())
        )
          throw new Error("Select a website to change its page zoom");
        const action = requiredString(request, "action");
        if (action !== "in" && action !== "out" && action !== "reset")
          throw new Error("Zoom action must be in, out or reset");
        const current = Math.round(contents.getZoomFactor() * 100);
        const zoomPercent =
          action === "reset"
            ? 100
            : action === "in"
              ? (siteZoomSteps.find((step) => step > current) ??
                siteZoomSteps.at(-1)!)
              : ([...siteZoomSteps].reverse().find((step) => step < current) ??
                siteZoomSteps[0]!);
        contents.setZoomFactor(zoomPercent / 100);
        return { zoomPercent: Math.round(contents.getZoomFactor() * 100) };
      }

      case "browser.navigate":
        return this.navigateBrowser(
          requiredString(request, "id"),
          requiredString(request, "url"),
          trustedUi && request.search === true,
        );

      case "browser.http-fallback": {
        const record = this.browser(requiredString(request, "id"));
        const offer = record.httpFallback;
        if (
          !record.error ||
          !offer ||
          offer.id !== requiredString(request, "offer")
        )
          throw new Error("This HTTP option is no longer available");
        await this.loadBrowser(record, offer.url, {
          replaceFailure: record.url,
        });
        return { id: record.id };
      }

      case "browser.continue-certificate": {
        if (!trustedUi) throw new Error("Confirm this action in Cod");
        const record = this.browser(requiredString(request, "id"));
        if (record.workspaceId !== this.store.data.activeWorkspaceId)
          throw new Error("Select the failed browser tab first");
        const certificate = this.requireBrowserService().takeCertificateOffer(
          record.id,
          record.url,
          requiredString(request, "offer"),
        );
        return this.openBrowser(
          {
            op: "browser.open",
            workspace: record.workspaceId,
            sourcePane: record.paneId,
            focus: true,
            url: record.url,
          },
          { certificate },
        );
      }

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
        const record = this.browser(id);
        if (record.agentPage)
          throw new Error(
            "Registered agent pages cannot recover browser navigation",
          );
        if (
          record.error &&
          record.httpFallback &&
          (!record.lastSuccessfulUrl || record.lastSuccessfulUrl === record.url)
        ) {
          await this.loadBrowser(record, "about:blank");
          return { id };
        }
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
