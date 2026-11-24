import { randomUUID } from "node:crypto";
import type { BrowserDownload } from "./download-types";
import { installPageContextMenu } from "./context-menu";
import { installScrollbarStyle } from "./scrollbars";
import {
  WebContentsView,
  dialog,
  type BrowserWindow,
  type Session,
  type WebContents,
  type DownloadItem,
} from "electron";
import { mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import path from "node:path";
import { BrowserDiagnostics } from "./diagnostics";
import { loadFavicon } from "./favicon";
import { faviconOrigin } from "./favicon-origin";
import {
  navigationWindow,
  normalizeNavigation,
  type BrowserNavigation,
} from "./navigation";

export interface BrowserSnapshot {
  navigation?: BrowserNavigation;
  id: string;
  workspaceId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  visible: boolean;
  error?: string;
  lastSuccessfulUrl?: string;
  favicon?: string;
}
export type BrowserEvent =
  | {
      type: "changed";
      id: string;
      workspaceId: string;
      snapshot: BrowserSnapshot;
    }
  | { type: "closed"; id: string; workspaceId: string }
  | {
      type: "download";
      id: string;
      workspaceId: string;
      download: BrowserDownload;
    };
interface Resource {
  navigation?: BrowserNavigation;
  id: string;
  workspaceId: string;
  view: WebContentsView;
  contents: WebContents;
  visible: boolean;
  error?: string;
  failedUrl?: string;
  unavailableHttps?: boolean;
  redirected?: boolean;
  restoredFailure?: boolean;
  restoredTitle?: string;
  lastSuccessfulUrl?: string;
  diagnostics?: BrowserDiagnostics;
  favicon?: string;
  pendingFavicon?: AbortController;
  faviconCandidates?: string;
  awaitingDocument?: boolean;
  popups: Set<BrowserWindow>;
  closing?: Promise<boolean>;
}
interface Options {
  window: BrowserWindow;
  session: Session;
  downloadDirectory: string;
  scrollbarCSS?: string;
  isAllowedExtensionUrl?: (url: string) => boolean;
  openLink?: (id: string, url: string) => Promise<unknown>;
  openExternal?: (url: string) => Promise<unknown>;
  onViewCreated?: (contents: WebContents, id: string) => void;
  onTabCreated?: (
    tab: BrowserSnapshot,
    openerId: string,
    background: boolean,
  ) => void;
}
function safeUrl(value: string, extension?: (url: string) => boolean): string {
  if (typeof value !== "string")
    throw new Error("Browser URL must be a string");
  const parsed = new URL(value);
  if (
    !["http:", "https:", "file:"].includes(parsed.protocol) &&
    parsed.href !== "about:blank" &&
    !extension?.(parsed.href)
  )
    throw new Error("Unsupported browser URL protocol");
  if (parsed.protocol === "file:" && parsed.host)
    throw new Error("Only local file addresses are supported");
  return parsed.href;
}
function allowed(value: string, extension?: (url: string) => boolean) {
  try {
    safeUrl(value, extension);
    return true;
  } catch {
    return false;
  }
}
function basename(value: string) {
  const clean = path.posix
    .basename(value.replaceAll("\\", "/"))
    .replace(/[\x00-\x1f\x7f]/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/[. ]+$/g, "");
  return clean && clean !== "." && clean !== ".." ? clean : "download";
}

/** Owns external browser resources only. The host supplies a dedicated browser session. */
export class BrowserService {
  private resources = new Map<string, Resource>();
  private owners = new Map<number, Resource>();
  private listeners = new Set<(event: BrowserEvent) => void>();
  private disposed = false;
  private favicons = new Map<string, string>();
  private retries = new Map<string, { count: number; expires: number }>();
  private downloads = new Map<
    string,
    { item: DownloadItem; update: () => void }
  >();
  controlDownload(id: string, action: "pause" | "resume" | "cancel") {
    const download = this.downloads.get(id);
    if (!download) throw new Error("Download is no longer active");
    if (
      action === "resume" &&
      !download.item.canResume() &&
      !download.item.isPaused()
    )
      throw new Error("Download cannot resume; retry it");
    download.item[action]();
    if (this.downloads.has(id)) download.update();
  }
  retryDownload(url: string) {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol))
      throw new Error("Only HTTP downloads can be retried");
    for (const [key, value] of this.retries)
      if (value.expires < Date.now()) this.retries.delete(key);
    this.retries.set(parsed.href, {
      count: (this.retries.get(parsed.href)?.count ?? 0) + 1,
      expires: Date.now() + 120000,
    });
    this.options.session.downloadURL(parsed.href);
  }
  constructor(private options: Options) {
    if (options.session === options.window.webContents.session)
      throw new Error("Browser session must be separate from the app session");
    if (!path.isAbsolute(options.downloadDirectory))
      throw new Error("Download directory must be absolute");
    options.session.on("will-download", this.download);
    options.window.once("closed", this.dispose);
  }
  owner(contentsId: number): string | undefined {
    return this.owners.get(contentsId)?.id;
  }
  onEvent(listener: (event: BrowserEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: BrowserEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* A consumer cannot break resource cleanup. */
      }
    }
  }
  private resource(id: string) {
    const resource = this.resources.get(id);
    if (!resource) throw new Error(`Unknown browser view: ${id}`);
    return resource;
  }
  private changed(resource: Resource) {
    if (
      this.resources.get(resource.id) !== resource ||
      resource.contents.isDestroyed()
    )
      return;
    this.emit({
      type: "changed",
      id: resource.id,
      workspaceId: resource.workspaceId,
      snapshot: this.snapshot(resource.id),
    });
  }
  cachedFavicon(url: string): string | undefined {
    const origin = faviconOrigin(url);
    return origin ? this.favicons.get(origin) : undefined;
  }
  private readFavicon(resource: Resource, candidates: string[]) {
    if (resource.awaitingDocument || resource.error) return;
    const origin = faviconOrigin(resource.contents.getURL());
    if (!origin) return;
    const key = JSON.stringify(
      candidates.slice(0, 4).filter((value) => value.length <= 2048),
    );
    if (resource.faviconCandidates === key) return;
    resource.faviconCandidates = key;
    resource.pendingFavicon?.abort();
    const pending = new AbortController();
    resource.pendingFavicon = pending;
    const signal = AbortSignal.any([
      pending.signal,
      AbortSignal.timeout(4_000),
    ]);
    void loadFavicon(this.options.session, origin, candidates, signal).then(
      (icon) => {
        if (
          signal.aborted ||
          resource.contents.isDestroyed() ||
          resource.error ||
          faviconOrigin(resource.contents.getURL()) !== origin ||
          icon === resource.favicon
        )
          return;
        if (icon) {
          this.favicons.delete(origin);
          this.favicons.set(origin, icon);
          if (this.favicons.size > 64)
            this.favicons.delete(this.favicons.keys().next().value!);
        }
        resource.favicon = icon;
        this.changed(resource);
      },
    );
  }
  private secure(contents: WebContents, resource: Resource) {
    installPageContextMenu(contents, this.options.window, {
      inspect: true,
      openLink: this.options.openLink
        ? (url) => this.options.openLink!(resource.id, url)
        : undefined,
      openExternal: this.options.openExternal,
    });
    this.owners.set(contents.id, resource);
    contents.once("destroyed", () => this.owners.delete(contents.id));
    const navigable = (url: string) =>
      allowed(url, this.options.isAllowedExtensionUrl) &&
      (!/^file:/i.test(url) || /^file:/i.test(contents.getURL()));
    contents.on("will-navigate", (event, url) => {
      if (!navigable(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!navigable(url)) event.preventDefault();
    });
    contents.on("will-frame-navigate", (event) => {
      // Chromium renders PDF streams in its built-in component extension frame.
      // This does not admit extension URLs as top-level pages or user popups.
      const pdfFrame =
        !event.isMainFrame &&
        event.url.startsWith(
          "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/",
        );
      if (!pdfFrame && !navigable(event.url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler((details) => {
      if (!navigable(details.url)) return { action: "deny" };
      const webPreferences = {
        session: this.options.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        preload: undefined,
      };
      if (["foreground-tab", "background-tab"].includes(details.disposition)) {
        return {
          action: "allow",
          outlivesOpener: true,
          overrideBrowserWindowOptions: { webPreferences },
          createWindow: (options) => {
            const tab = this.createResource(
              { id: randomUUID(), workspaceId: resource.workspaceId },
              options,
            );
            this.options.onTabCreated?.(
              { ...this.snapshot(tab.id), url: details.url },
              resource.id,
              details.disposition === "background-tab",
            );
            return tab.contents;
          },
        };
      }
      return {
        action: "allow",
        overrideBrowserWindowOptions: { webPreferences },
      };
    });
    contents.on("did-create-window", (window) => {
      if (this.disposed || !this.resources.has(resource.id)) {
        window.destroy();
        return;
      }
      resource.popups.add(window);
      window.once("closed", () => resource.popups.delete(window));
      this.secure(window.webContents, resource);
    });
    this.options.onViewCreated?.(contents, resource.id);
  }
  private createResource(
    input: { id: string; workspaceId: string },
    options?: Electron.WebContentsViewConstructorOptions,
  ): Resource {
    if (this.disposed) throw new Error("Browser service is closed");
    if (!input.id || !input.workspaceId)
      throw new Error("Browser view and workspace IDs are required");
    if (this.resources.has(input.id))
      throw new Error("Browser view ID already exists");
    // createWindow supplies an existing WebContents: adopt it so Chromium can
    // complete window.open with its original opener and pending POST request.
    const view = new WebContentsView({
      ...options,
      webPreferences: {
        ...options?.webPreferences,
        session: this.options.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        preload: undefined,
      },
    });
    const resource: Resource = {
      id: input.id,
      workspaceId: input.workspaceId,
      view,
      contents: view.webContents,
      visible: false,
      popups: new Set(),
    };
    this.resources.set(input.id, resource);
    resource.contents.once("destroyed", () =>
      this.close(resource.id, resource.contents),
    );
    try {
      // New native views stay inert until the renderer supplies their viewport.
      // Attaching a visible full-window view can steal focus from a background opener.
      view.setVisible(false);
      this.options.window.contentView.addChildView(view);
      const size = this.options.window.getContentSize();
      view.setBounds({
        x: 0,
        y: 0,
        width: Math.max(1, size[0]),
        height: Math.max(1, size[1]),
      });
      this.secure(view.webContents, resource);
      if (this.options.scrollbarCSS)
        installScrollbarStyle(view.webContents, this.options.scrollbarCSS);
      const changed = () => this.changed(resource);
      view.webContents.on("will-redirect", (event) => {
        if (event.isMainFrame) resource.redirected = true;
      });
      view.webContents.on(
        "did-start-navigation",
        (_event, _url, inPlace, mainFrame) => {
          if (!mainFrame || inPlace) return;
          resource.pendingFavicon?.abort();
          resource.favicon = undefined;
          resource.faviconCandidates = undefined;
          resource.awaitingDocument = true;
          resource.restoredFailure = false;
          resource.error = undefined;
          resource.failedUrl = undefined;
          resource.unavailableHttps = false;
          resource.redirected = false;
          changed();
        },
      );
      view.webContents.on(
        "did-fail-load",
        (_event, code, description, failedUrl, mainFrame) => {
          // Aborted loads include superseded navigations and downloads, not page failures.
          if (!mainFrame || code === -3) return;
          resource.error = `Page could not load (${description || `network error ${code}`}). Reload to try again.`;
          resource.failedUrl = failedUrl;
          // Chromium ERR_CONNECTION_REFUSED and ERR_SSL_PROTOCOL_ERROR.
          resource.unavailableHttps =
            !resource.redirected && (code === -102 || code === -107);
          changed();
        },
      );
      view.webContents.on("render-process-gone", (_event, details) => {
        resource.error = `Page stopped (${details.reason}). Reload to try again.`;
        resource.failedUrl = view.webContents.getURL();
        resource.unavailableHttps = false;
        changed();
      });
      view.webContents.on("did-start-loading", changed);
      view.webContents.on("did-stop-loading", changed);
      const committed = () => this.updateNavigation(resource);
      view.webContents.on("did-navigate", () => {
        resource.awaitingDocument = false;
        committed();
      });
      view.webContents.on("page-favicon-updated", (_event, urls) =>
        this.readFavicon(resource, urls),
      );
      view.webContents.on("did-finish-load", () => {
        const url = resource.contents.getURL();
        if (!resource.error && /^https?:\/\//.test(url))
          resource.lastSuccessfulUrl = url;
        changed();
      });
      view.webContents.on(
        "did-navigate-in-page",
        (_event, committedUrl, mainFrame) => {
          if (mainFrame) {
            if (
              !resource.error &&
              !resource.contents.isLoadingMainFrame() &&
              /^https?:\/\//.test(committedUrl)
            )
              resource.lastSuccessfulUrl = committedUrl;
            committed();
          }
        },
      );
      view.webContents.on("page-title-updated", changed);
      return resource;
    } catch (error) {
      if (this.resources.get(input.id) === resource) this.close(input.id);
      throw error;
    }
  }
  async open(input: {
    id: string;
    workspaceId: string;
    url: string;
    deferNavigation?: boolean;
    navigation?: BrowserNavigation;
    beforeNavigation?: () => Promise<void>;
    restoredFailure?: {
      url: string;
      error: string;
      title?: string;
      lastSuccessfulUrl?: string;
      navigation?: BrowserNavigation;
    };
  }) {
    const url = safeUrl(input.url, this.options.isAllowedExtensionUrl);
    const resource = this.createResource(input);
    try {
      if (input.beforeNavigation) await input.beforeNavigation();
      const saved = normalizeNavigation(input.restoredFailure?.navigation);
      const previous = saved?.entries.filter(
        (entry) =>
          entry.url !== input.restoredFailure?.url &&
          entry.url !== "about:blank",
      );
      if (input.restoredFailure && previous?.length)
        await this.restoreNavigation(input.id, {
          entries: [...previous, { url: "about:blank", title: "" }],
          index: previous.length,
        });
      else if (input.navigation)
        await this.restoreNavigation(input.id, input.navigation);
      else if (!input.deferNavigation) await this.load(resource, url);
      if (input.restoredFailure) {
        resource.restoredFailure = true;
        resource.restoredTitle =
          input.restoredFailure.title &&
          input.restoredFailure.title !== "about:blank"
            ? input.restoredFailure.title
            : new URL(input.restoredFailure.url).hostname;
        resource.failedUrl = safeUrl(
          input.restoredFailure.url,
          this.options.isAllowedExtensionUrl,
        );
        resource.error = input.restoredFailure.error;
        const previous = input.restoredFailure.lastSuccessfulUrl;
        if (previous && /^https?:\/\//.test(previous))
          resource.lastSuccessfulUrl = safeUrl(previous);
        this.changed(resource);
      }
      return this.snapshot(input.id);
    } catch (error) {
      if (this.resources.get(input.id) === resource) this.close(input.id);
      throw error;
    }
  }
  private async load(resource: Resource, url: string) {
    const contents = resource.contents;
    try {
      await contents.loadURL(url);
    } catch (error) {
      if (resource.error) throw new Error(resource.error);
      throw error;
    }
    if (contents.isLoading())
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          contents.removeListener("did-stop-loading", stopped);
          contents.removeListener("destroyed", destroyed);
        };
        const stopped = () => {
          cleanup();
          resolve();
        };
        const destroyed = () => {
          cleanup();
          reject(new Error("Browser view closed during navigation"));
        };
        contents.once("did-stop-loading", stopped);
        contents.once("destroyed", destroyed);
      });
    if (this.resources.get(resource.id) !== resource)
      throw new Error("Browser view closed during navigation");
  }
  private updateNavigation(resource: Resource): void {
    const history = resource.contents.navigationHistory;
    const index = history.getActiveIndex();
    const { start, end } = navigationWindow(history.length(), index);
    const entries = [];
    for (let i = start; i < end; i++) {
      const entry = history.getEntryAtIndex(i);
      entries.push({ url: entry.url, title: entry.title });
    }
    resource.navigation = normalizeNavigation({
      entries,
      index: index - start,
    });
    this.changed(resource);
  }
  async navigate(id: string, url: string, replaceFailure?: string) {
    const resource = this.resource(id);
    const history = resource.contents.navigationHistory;
    const index = history.getActiveIndex();
    const replace =
      !!replaceFailure &&
      resource.failedUrl === replaceFailure &&
      history.getEntryAtIndex(index)?.url === replaceFailure;
    await this.load(resource, safeUrl(url, this.options.isAllowedExtensionUrl));
    // Only remove the exact failed predecessor that this successful load replaced.
    if (
      replace &&
      history.getActiveIndex() === index + 1 &&
      history.getEntryAtIndex(index)?.url === replaceFailure &&
      history.removeEntryAtIndex(index)
    )
      this.updateNavigation(resource);
    return this.snapshot(id);
  }
  httpsUnavailable(id: string, url: string): boolean {
    const resource = this.resources.get(id);
    return !!(resource?.unavailableHttps && resource.failedUrl === url);
  }
  async restoreNavigation(id: string, value: BrowserNavigation) {
    const resource = this.resource(id);
    const navigation = normalizeNavigation(value);
    if (!navigation) throw new Error("Saved browser history is invalid");
    resource.navigation = navigation;
    await resource.contents.navigationHistory.restore(navigation);
    if (this.resources.get(id) !== resource)
      throw new Error("Browser view closed during restoration");
    return this.snapshot(id);
  }
  back(id: string) {
    const wc = this.resource(id).contents;
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }
  forward(id: string) {
    const wc = this.resource(id).contents;
    if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }
  async recover(id: string) {
    const resource = this.resource(id);
    const target = resource.lastSuccessfulUrl;
    if (!resource.error || !target || target === resource.failedUrl)
      throw new Error("No previous page is available for recovery");
    const history = resource.contents.navigationHistory;
    const previous = history.getAllEntries()[history.getActiveIndex() - 1];
    if (history.canGoBack() && previous?.url === target) history.goBack();
    else await this.navigate(id, target);
  }
  reload(id: string) {
    const resource = this.resource(id);
    if (resource.failedUrl) {
      void this.load(resource, resource.failedUrl).catch(() => {});
    } else resource.contents.reload();
  }
  snapshot(id: string): BrowserSnapshot {
    const resource = this.resource(id),
      wc = resource.contents;
    if (wc.isDestroyed()) throw new Error("Browser view is closed");
    return {
      id,
      workspaceId: resource.workspaceId,
      url: resource.failedUrl || wc.getURL(),
      title: resource.restoredFailure
        ? resource.restoredTitle || "Page could not load"
        : wc.getTitle(),
      loading: !resource.error && wc.isLoading(),
      error: resource.error,
      lastSuccessfulUrl: resource.lastSuccessfulUrl,
      navigation: resource.navigation,
      favicon: resource.error ? undefined : resource.favicon,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      visible: resource.visible,
    };
  }
  list() {
    return [...this.resources.values()]
      .filter((resource) => !resource.contents.isDestroyed())
      .map((resource) => this.snapshot(resource.id));
  }
  diagnosticContext(contentsId: number) {
    const owner = this.owners.get(contentsId);
    return owner
      ? { browserId: owner.id, workspaceId: owner.workspaceId }
      : undefined;
  }
  getWebContents(id: string) {
    return this.resource(id).contents;
  }
  setBounds(
    id: string,
    bounds: { x: number; y: number; width: number; height: number },
  ) {
    const resource = this.resource(id);
    if (
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(
        Number.isFinite,
      ) ||
      bounds.x < 0 ||
      bounds.y < 0 ||
      !Number.isInteger(bounds.width) ||
      !Number.isInteger(bounds.height) ||
      bounds.width < 1 ||
      bounds.height < 1
    )
      throw new Error("Invalid browser view bounds");
    resource.view.setBounds(bounds);
  }
  async captureOverviewBackdrop(id: string) {
    const resource = this.resource(id);
    const { contents, view } = resource;
    const { width, height } = view.getBounds();
    if (!resource.visible || width * height > 9_000_000) return;
    const url = contents.getURL();
    let image = await contents.capturePage(undefined, { stayHidden: true });
    if (contents.isDestroyed() || contents.getURL() !== url || image.isEmpty())
      return;
    const size = image.getSize();
    const scale = Math.min(1, 1600 / Math.max(size.width, size.height));
    if (scale < 1)
      image = image.resize({
        width: Math.max(1, Math.floor(size.width * scale)),
      });
    const bytes = image.toJPEG(75);
    return bytes.length <= 384 * 1024 ? { url, bytes } : undefined;
  }
  setVisible(id: string, visible: boolean) {
    const resource = this.resource(id);
    if (typeof visible !== "boolean")
      throw new Error("Visibility must be boolean");
    resource.view.setVisible(visible);
    resource.visible = visible;
    this.changed(resource);
  }
  focus(id: string) {
    const resource = this.resource(id);
    if (!resource.visible)
      throw new Error("Cannot focus a hidden browser view");
    resource.contents.focus();
  }
  diagnostics(id: string, action: "start" | "read" | "stop") {
    const resource = this.resource(id);
    resource.diagnostics ??= new BrowserDiagnostics(resource.contents, () =>
      resource.restoredFailure && resource.error
        ? resource.failedUrl
        : undefined,
    );
    return resource.diagnostics[action]();
  }
  requestClose(id: string): Promise<boolean> {
    const resource = this.resources.get(id);
    if (!resource || resource.contents.isDestroyed())
      return Promise.resolve(true);
    if (resource.closing) return resource.closing;
    resource.diagnostics?.stop();
    const contents = resource.contents;
    const pending = new Promise<boolean>((resolve, reject) => {
      const finish = (closed: boolean) => {
        contents.removeListener("destroyed", destroyed);
        contents.removeListener("will-prevent-unload", blocked);
        resource.closing = undefined;
        if (closed) this.close(id, contents);
        resolve(closed);
      };
      const destroyed = () => finish(true);
      const blocked = () => {
        // Default prevention keeps the page intact while the native confirmation
        // is open. Only an explicit Leave retries without the page guard.
        void dialog
          .showMessageBox(this.options.window, {
            type: "warning",
            title: "Leave page?",
            message: "Changes you made may not be saved.",
            buttons: ["Stay", "Leave"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          })
          .then(({ response }) => {
            if (contents.isDestroyed()) return;
            if (response === 1) this.close(id, contents);
            else finish(false);
          })
          .catch(() => finish(false));
      };
      contents.once("destroyed", destroyed);
      contents.once("will-prevent-unload", blocked);
      try {
        contents.close({ waitForBeforeUnload: true });
      } catch (error) {
        contents.removeListener("destroyed", destroyed);
        contents.removeListener("will-prevent-unload", blocked);
        resource.closing = undefined;
        reject(error);
      }
    });
    resource.closing = pending;
    return pending;
  }
  close(id: string, contents?: WebContents) {
    const resource = this.resources.get(id);
    if (!resource || (contents && contents !== resource.contents)) return;
    resource.diagnostics?.dispose();
    resource.pendingFavicon?.abort();
    this.resources.delete(id);
    for (const popup of resource.popups)
      if (!popup.isDestroyed()) popup.destroy();
    resource.popups.clear();
    if (
      !this.options.window.isDestroyed() &&
      this.options.window.contentView.children.includes(resource.view)
    )
      this.options.window.contentView.removeChildView(resource.view);
    const target = contents ?? resource.contents;
    if (!target.isDestroyed()) target.close({ waitForBeforeUnload: false });
    this.emit({ type: "closed", id, workspaceId: resource.workspaceId });
  }
  dispose = () => {
    if (this.disposed) return;
    for (const download of this.downloads.values()) download.item.cancel();
    this.disposed = true;
    this.options.session.removeListener("will-download", this.download);
    this.options.window.removeListener("closed", this.dispose);
    for (const id of [...this.resources.keys()]) this.close(id);
    this.listeners.clear();
  };
  private download = (
    _event: Electron.Event,
    item: DownloadItem,
    contents: WebContents | null,
  ) => {
    if (!contents) {
      const pending = this.retries.get(item.getURL());
      if (!pending || pending.expires < Date.now()) return;
      if (--pending.count === 0) this.retries.delete(item.getURL());
    }
    const owner = contents ? this.owners.get(contents.id) : undefined;
    if (this.disposed || (contents && !owner)) {
      item.cancel();
      return;
    }
    const id = randomUUID(),
      startedAt = Date.now();
    const name = basename(item.getFilename());
    let destination = "";
    try {
      mkdirSync(this.options.downloadDirectory, { recursive: true });
      for (let suffix = 0; suffix < 10000; suffix++) {
        const extension = path.extname(name),
          stem = name.slice(0, name.length - extension.length);
        const candidate = path.join(
          this.options.downloadDirectory,
          suffix ? `${stem} (${suffix})${extension}` : name,
        );
        try {
          closeSync(openSync(candidate, "wx", 0o600));
          destination = candidate;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      if (!destination) throw new Error("No available download filename");
      item.setSavePath(destination);
    } catch {
      item.cancel();
      this.emit({
        type: "download",
        id: owner?.id ?? "",
        workspaceId: owner?.workspaceId ?? "",
        download: {
          id,
          startedAt,
          url: item.getURL(),
          basename: name,
          status: "interrupted",
          receivedBytes: 0,
          totalBytes: 0,
          canResume: false,
        },
      });
      return;
    }
    const send = (
      status: "progressing" | "completed" | "cancelled" | "interrupted",
    ) =>
      this.emit({
        type: "download",
        id: owner?.id ?? "",
        workspaceId: owner?.workspaceId ?? "",
        download: {
          id,
          startedAt,
          url: item.getURL(),
          basename: path.basename(destination),
          status:
            status === "progressing" && item.isPaused() ? "paused" : status,
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          canResume:
            this.downloads.has(id) &&
            (status === "progressing" ||
              (status === "interrupted" && item.canResume())),
          ...(status === "completed" ? { path: destination } : {}),
        },
      });
    item.on("updated", (_event, state) => send(state));
    item.once("done", (_event, state) => {
      this.downloads.delete(id);
      if (state !== "completed") {
        try {
          unlinkSync(destination);
        } catch {
          /* Download cancellation may already remove its partial file. */
        }
      }
      send(state);
    });
    this.downloads.set(id, { item, update: () => send(item.getState()) });
    send("progressing");
  };
}
