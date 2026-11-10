import {
  app,
  ipcMain,
  protocol,
  WebContentsView,
  type BrowserWindow,
  type Session,
  type WebContents,
  type IpcMainInvokeEvent,
  type CustomScheme,
  type OnBeforeRequestListenerDetails,
} from "electron";
import { randomUUID } from "node:crypto";
import { realpath, stat, open } from "node:fs/promises";
import path from "node:path";
const SCHEME = "cod-artifact";
let schemeRegistered = false;
export function registerAgentPageScheme(
  additionalSchemes: CustomScheme[] = [],
) {
  if (schemeRegistered) {
    if (additionalSchemes.length)
      throw new Error("Schemes must be registered in one combined call");
    return;
  }
  if (app.isReady())
    throw new Error("Register agent page scheme before Electron is ready");
  if (additionalSchemes.some((entry) => entry.scheme === SCHEME))
    throw new Error("Agent scheme privileges cannot be overridden");
  protocol.registerSchemesAsPrivileged([
    ...additionalSchemes,
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
  schemeRegistered = true;
}
export interface BoundSubmission {
  pageId: string;
  workspaceId: string;
  conversationId: string;
  submissionId: string;
  payload: unknown;
}
interface Options {
  window: BrowserWindow;
  session: Session;
  preloadPath: string;
  onSubmit: (submission: BoundSubmission) => Promise<void> | void;
}
interface Record {
  id: string;
  workspaceId: string;
  conversationId: string;
  path: string;
  url: string;
  host: string;
  directory: string;
  view: WebContentsView;
  visible: boolean;
}
const inside = (root: string, file: string) =>
  file === root ||
  (!path.relative(root, file).startsWith(".." + path.sep) &&
    path.relative(root, file) !== ".." &&
    !path.isAbsolute(path.relative(root, file)));
const mime: globalThis.Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
function jsonPayload(payload: unknown) {
  const seen = new Set<object>();
  let nodes = 0;
  const validate = (value: unknown, depth: number) => {
    if (++nodes > 20000 || depth > 64) throw new Error("Invalid form response");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || seen.has(value))
      throw new Error("Invalid form response");
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error("Invalid form response");
    seen.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value))
      validate(child, depth + 1);
    seen.delete(value);
  };
  validate(payload, 0);
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > 65536)
    throw new Error("Form response exceeds 64 KiB");
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    ["pageId", "workspaceId", "conversationId", "submissionId"].some((key) =>
      Object.hasOwn(payload, key),
    )
  )
    throw new Error("Form response cannot override page identity");
  return JSON.parse(encoded);
}
export class AgentPageService {
  private pages = new Map<string, Record>();
  private hosts = new Map<string, Record>();
  private owners = new Map<number, Record>();
  private channel = `cod-page:${randomUUID()}`;
  private disposed = false;
  private ready: Promise<void>;
  constructor(private options: Options) {
    if (!schemeRegistered)
      throw new Error("Agent page scheme was not registered");
    if (
      options.session === options.window.webContents.session ||
      options.session.getStoragePath() !== null
    )
      throw new Error("Agent pages require a separate in-memory session");
    if (!path.isAbsolute(options.preloadPath))
      throw new Error("Agent preload must be absolute");
    this.ready = Promise.resolve(
      options.session.protocol.isProtocolHandled(SCHEME),
    ).then((handled) => {
      if (handled) throw new Error("Agent session protocol already owned");
      options.session.webRequest.onBeforeRequest(
        { urls: [`${SCHEME}://*/*`] },
        (details, callback) =>
          callback({ cancel: !this.authorizeRequest(details) }),
      );
      options.session.protocol.handle(SCHEME, this.serve);
    });
    this.ready.catch(() => {});
    options.session.setPermissionCheckHandler(() => false);
    options.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    ipcMain.handle(this.channel, this.submit);
    options.window.once("closed", this.dispose);
  }
  private page(id: string) {
    const page = this.pages.get(id);
    if (!page) throw new Error("Unknown agent page");
    return page;
  }
  private authorizeRequest(details: OnBeforeRequestListenerDetails): boolean {
    try {
      const target = new URL(details.url);
      const page = this.hosts.get(target.host);
      if (this.disposed || !page || details.method !== "GET") return false;
      const contents = page.view.webContents;
      if (
        contents.isDestroyed() ||
        details.webContentsId !== contents.id ||
        details.webContents !== contents ||
        !details.frame ||
        details.frame.top !== contents.mainFrame
      )
        return false;
      const registered = new URL(page.url);
      if (details.resourceType === "mainFrame")
        return (
          details.frame === contents.mainFrame &&
          target.pathname === registered.pathname
        );
      const current = new URL(contents.getURL());
      if (
        current.protocol !== registered.protocol ||
        current.host !== registered.host ||
        current.pathname !== registered.pathname
      )
        return false;
      const requesting = new URL(
        details.resourceType === "subFrame"
          ? (details.frame.parent?.url ?? "")
          : details.frame.url,
      );
      return (
        requesting.protocol === registered.protocol &&
        requesting.host === registered.host
      );
    } catch {
      return false;
    }
  }
  private serve = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url),
        page = this.hosts.get(url.host);
      if (
        this.disposed ||
        url.protocol !== SCHEME + ":" ||
        !page ||
        request.method !== "GET"
      )
        return new Response("Not found", { status: 404 });
      const decoded = decodeURIComponent(url.pathname);
      if (
        decoded.includes("\\") ||
        decoded.includes("\0") ||
        decoded.split("/").some((part) => part === ".." || part === ".") ||
        /%(?:2e|2f|5c|00)/i.test(decoded)
      )
        return new Response("Not found", { status: 404 });
      const target = await realpath(
        path.resolve(page.directory, "." + decoded),
      );
      if (!inside(page.directory, target))
        return new Response("Not found", { status: 404 });
      const info = await stat(target);
      if (!info.isFile() || info.size > 8 * 1024 * 1024)
        return new Response("Not found", { status: 404 });
      const handle = await open(target, "r");
      let body: Buffer<ArrayBuffer>;
      try {
        const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
        let used = 0;
        while (used < buffer.length) {
          const chunk = await handle.read(
            buffer,
            used,
            buffer.length - used,
            used,
          );
          if (!chunk.bytesRead) break;
          used += chunk.bytesRead;
        }
        if (used > 8 * 1024 * 1024)
          return new Response("Not found", { status: 404 });
        body = buffer.subarray(0, used);
      } finally {
        await handle.close();
      }
      return new Response(body, {
        headers: {
          "Content-Type":
            mime[path.extname(target).toLowerCase()] ??
            "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          "Access-Control-Allow-Origin": "*",
          "Content-Security-Policy":
            "sandbox allow-scripts allow-forms; object-src 'none'; base-uri 'none'",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
  private submit = async (event: IpcMainInvokeEvent, payload: unknown) => {
    const failure = {
      ok: false,
      error: "Form response could not be submitted.",
    };
    try {
      const page = this.owners.get(event.sender.id);
      if (
        this.disposed ||
        !page ||
        event.sender.isDestroyed() ||
        event.sender !== page.view.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        return failure;
      const current = new URL(event.senderFrame.url),
        registered = new URL(page.url);
      if (
        current.protocol !== registered.protocol ||
        current.host !== registered.host ||
        current.pathname !== registered.pathname ||
        event.sender.getURL() !== event.senderFrame.url
      )
        return failure;
      const data = jsonPayload(payload),
        submissionId = randomUUID();
      await this.options.onSubmit(
        Object.freeze({
          pageId: page.id,
          workspaceId: page.workspaceId,
          conversationId: page.conversationId,
          submissionId,
          payload: data,
        }),
      );
      return { ok: true, submissionId };
    } catch {
      return failure;
    }
  };
  async open(input: {
    id: string;
    workspaceId: string;
    conversationId: string;
    path: string;
  }) {
    await this.ready;
    if (this.disposed) throw new Error("Agent page service is closed");
    if (
      ![input.id, input.workspaceId, input.conversationId].every(
        (value) =>
          typeof value === "string" && value.length > 0 && value.length <= 256,
      ) ||
      !path.isAbsolute(input.path)
    )
      throw new Error("Explicit page identity and absolute HTML path required");
    if (this.pages.has(input.id))
      throw new Error("Agent page ID already exists");
    const file = await realpath(input.path);
    if (
      ![".html", ".htm"].includes(path.extname(file).toLowerCase()) ||
      !(await stat(file)).isFile()
    )
      throw new Error("Registered artifact must be HTML");
    const host = randomUUID(),
      url = `${SCHEME}://${host}/${encodeURIComponent(path.basename(file))}`;
    // Recheck after asynchronous filesystem validation; never replace a concurrent registration.
    if (this.disposed || this.pages.has(input.id))
      throw new Error("Agent registration no longer available");
    const view = new WebContentsView({
      webPreferences: {
        session: this.options.session,
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        additionalArguments: [
          `--cod-page-channel=${this.channel}`,
          `--cod-page-host=${host}`,
          `--cod-page-entry=${new URL(url).pathname}`,
        ],
      },
    });
    view.setVisible(false);
    const page: Record = {
      ...input,
      path: file,
      url,
      host,
      directory: path.dirname(file),
      view,
      visible: false,
    };
    this.pages.set(input.id, page);
    this.hosts.set(host, page);
    const contents = view.webContents,
      contentsId = contents.id;
    this.owners.set(contentsId, page);
    contents.once("destroyed", () => this.owners.delete(contentsId));
    this.options.window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    const allowed = (value: string) => {
      try {
        const candidate = new URL(value);
        return (
          ["http:", "https:", SCHEME + ":"].includes(candidate.protocol) ||
          candidate.href === "about:blank"
        );
      } catch {
        return false;
      }
    };
    contents.on("will-navigate", (event, url) => {
      if (!allowed(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!allowed(url)) event.preventDefault();
    });
    contents.on("will-frame-navigate", (event) => {
      if (!allowed(event.url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    try {
      await contents.loadURL(url);
      if (this.pages.get(input.id) !== page)
        throw new Error("Agent page closed while loading");
      return this.snapshot(input.id);
    } catch (error) {
      if (this.pages.get(input.id) === page) this.close(input.id);
      throw error;
    }
  }
  snapshot(id: string) {
    const page = this.page(id);
    return {
      id: page.id,
      workspaceId: page.workspaceId,
      conversationId: page.conversationId,
      path: page.path,
      url: page.url,
      visible: page.visible,
    };
  }
  setSubmissionState(id: string, state: string | null) {
    this.page(id).view.webContents.send("cod:page-submission", state);
  }
  list() {
    return [...this.pages.keys()].map((id) => this.snapshot(id));
  }
  getWebContents(id: string) {
    return this.page(id).view.webContents;
  }
  setBounds(
    id: string,
    bounds: { x: number; y: number; width: number; height: number },
  ) {
    const page = this.page(id);
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
      throw new Error("Invalid agent page bounds");
    page.view.setBounds(bounds);
  }
  setVisible(id: string, visible: boolean) {
    if (typeof visible !== "boolean")
      throw new Error("Visibility must be boolean");
    const page = this.page(id);
    page.view.setVisible(visible);
    page.visible = visible;
  }
  focus(id: string) {
    const page = this.page(id);
    if (!page.visible) throw new Error("Cannot focus hidden agent page");
    page.view.webContents.focus();
  }
  close(id: string) {
    const page = this.pages.get(id);
    if (!page) return;
    this.pages.delete(id);
    this.hosts.delete(page.host);
    this.owners.delete(page.view.webContents.id);
    if (!this.options.window.isDestroyed())
      this.options.window.contentView.removeChildView(page.view);
    if (!page.view.webContents.isDestroyed())
      page.view.webContents.close({ waitForBeforeUnload: false });
  }
  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.pages.keys()]) this.close(id);
    ipcMain.removeHandler(this.channel);
    this.options.window.removeListener("closed", this.dispose);
    void this.ready
      .then(() => {
        this.options.session.webRequest.onBeforeRequest(null);
        this.options.session.protocol.unhandle(SCHEME);
      })
      .catch(() => {});
  };
}
