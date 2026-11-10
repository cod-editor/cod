import { prepareExtension } from "./extension-install";
import {
  BrowserWindow,
  webContents,
  type Session,
  type WebContents,
} from "electron";
import { ElectronChromeExtensions } from "electron-chrome-extensions";
import {
  ElectronBlocker,
  adsAndTrackingLists,
} from "@ghostery/adblocker-electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
export interface AddonStatus {
  bitwarden: {
    status: "missing" | "loading" | "ready" | "failed";
    extensionId?: string;
    error?: string;
  };
  adblock: {
    status: "loading" | "ready" | "failed";
    enabled: boolean;
    hostname: string;
    error?: string;
    cached?: boolean;
  };
}
interface Options {
  directory: string;
  session: Session;
  window: BrowserWindow;
  changed: () => void;
  createTab: (url: string) => Promise<WebContents>;
  selectTab: (contents: WebContents) => void;
  removeTab: (contents: WebContents) => void;
}
const resourceDefault =
  "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json";
// The upstream registry publishes the same maintained Base filter on GitHub.
// Use the source registry alongside the other GitHub-hosted default lists.
const baseList =
  "https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_2_Base/filter.txt";
const digest = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const hostname = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};
function checkedUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Filter source must be a URL");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Filter sources require HTTP(S)");
  return url.href;
}
export class BrowserAddons {
  readonly extensions: ElectronChromeExtensions;
  private bitwarden: AddonStatus["bitwarden"] = {
    status: "missing",
    error:
      "Bitwarden unavailable: run npm run prepare:bitwarden or set COD_BITWARDEN_EXTENSION_PATH.",
  };
  private blocking: Omit<AddonStatus["adblock"], "enabled" | "hostname"> = {
    status: "loading",
  };
  private disabled = new Set<string>();
  private engine?: ElectronBlocker;
  private started = false;
  private loading?: Promise<void>;
  private disposed = false;
  private controllers = new Set<AbortController>();
  private ready: Promise<void>;
  private protectionReady: Promise<void>;
  private resolveProtection!: () => void;
  private writes = Promise.resolve();
  constructor(private options: Options) {
    this.protectionReady = new Promise((resolve) => {
      this.resolveProtection = resolve;
    });
    this.extensions = new ElectronChromeExtensions({
      session: options.session,
      createTab: async (details) => [
        await options.createTab(details.url ?? "about:blank"),
        options.window,
      ],
      selectTab: (contents) => options.selectTab(contents),
      removeTab: (contents) => options.removeTab(contents),
      createWindow: async (details) => {
        if (details.url)
          await options.createTab(
            Array.isArray(details.url) ? details.url[0] : details.url,
          );
        return options.window;
      },
    });
    this.extensions.on("browser-action-popup-created", (popup) => {
      void popup
        .whenReady()
        .then(() => {
          if (popup.isDestroyed()) return;
          popup.setSize({ width: 480, height: 600 });
          popup.browserWindow?.show();
        })
        .catch(() => {});
    });
    this.ready = this.initialize();
    void this.ready.catch(() => {});
  }
  private async initialize() {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(
        await readFile(path.join(this.options.directory, "hosts.json"), "utf8"),
      );
      if (Array.isArray(saved.disabledHosts))
        this.disabled = new Set(
          saved.disabledHosts.filter(
            (host: unknown) => typeof host === "string",
          ),
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.blocking.error = "Saved host exceptions could not be read.";
    }
    let extensionPath = process.env.COD_BITWARDEN_EXTENSION_PATH;
    if (!extensionPath)
      for (const candidate of [
        path.join(__dirname, "../extensions/bitwarden"),
        path.join(__dirname, "../artifacts/bitwarden/extension"),
        path.join(this.options.directory, "bitwarden"),
      ]) {
        try {
          await stat(path.join(candidate, "manifest.json"));
          extensionPath = candidate;
          break;
        } catch {}
      }
    extensionPath ??= path.join(this.options.directory, "bitwarden");
    try {
      await stat(path.join(extensionPath, "manifest.json"));
    } catch {
      this.options.changed();
      return;
    }
    this.bitwarden = { status: "loading" };
    this.options.changed();
    try {
      const manifest = JSON.parse(
        await readFile(path.join(extensionPath, "manifest.json"), "utf8"),
      );
      if (manifest.version !== "2026.10.2")
        throw new Error("Expected pinned official Bitwarden 2026.10.2");
      extensionPath = await prepareExtension(
        extensionPath,
        this.options.directory,
      );
      let expired = false;
      const load = this.options.session.extensions.loadExtension(extensionPath);
      let timer: ReturnType<typeof setTimeout> | undefined;
      void load
        .then((extension) => {
          if (expired || this.disposed)
            this.options.session.extensions.removeExtension(extension.id);
        })
        .catch(() => {});
      const extension = await Promise.race([
        load,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error("Bitwarden setup timed out"));
          }, 15000);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (this.disposed) return;
      this.bitwarden = { status: "ready", extensionId: extension.id };
    } catch (error) {
      this.bitwarden = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.options.changed();
  }
  async whenReady(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("Browser admission cancelled");
    let rejectAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error("Browser admission cancelled"));
      signal.addEventListener("abort", rejectAbort, { once: true });
    });
    try {
      await Promise.race([
        Promise.all([this.ready, this.protectionReady]),
        cancelled,
      ]);
    } finally {
      signal.removeEventListener("abort", rejectAbort);
    }
  }
  allows(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        this.bitwarden.status === "ready" &&
        parsed.protocol === "chrome-extension:" &&
        parsed.hostname === this.bitwarden.extensionId
      );
    } catch {
      return false;
    }
  }
  register(contents: WebContents) {
    this.extensions.addTab(
      contents,
      BrowserWindow.fromWebContents(contents) ?? this.options.window,
    );
    if (!this.started) {
      this.started = true;
      void this.retryBlocking().finally(() => this.resolveProtection());
    }
  }
  retryBlocking(): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error("Browser add-ons closed"));
    if (this.loading) return this.loading;
    if (!this.engine) this.blocking = { status: "loading" };
    this.options.changed();
    const loading = this.load()
      .catch(() => {
        if (this.disposed) return;
        this.blocking = {
          status: this.engine ? "ready" : "failed",
          cached: Boolean(this.engine),
          error: this.engine
            ? "Filter setup failed; using last-known-good filters. Check the filter configuration and retry."
            : "Blocking unavailable. Check the filter configuration and retry.",
        };
        this.options.changed();
      })
      .finally(() => {
        if (this.loading === loading) this.loading = undefined;
      });
    this.loading = loading;
    return loading;
  }
  select(contents: WebContents) {
    if (!contents.isDestroyed()) this.extensions.selectTab(contents);
  }
  status(url: string): AddonStatus {
    const host = hostname(url);
    return {
      bitwarden: { ...this.bitwarden },
      adblock: {
        ...this.blocking,
        hostname: host,
        enabled:
          this.blocking.status === "ready" &&
          Boolean(host) &&
          !this.disabled.has(host),
      },
    };
  }
  async toggle(url: string, enabled: boolean) {
    await this.ready;
    const host = hostname(url);
    if (!host || !/^https?:/.test(url))
      throw new Error("Ad blocking requires an HTTP(S) site");
    if (this.blocking.status !== "ready")
      throw new Error("Ad blocking is unavailable");
    const job = this.writes.then(async () => {
      const next = new Set(this.disabled);
      if (enabled) next.delete(host);
      else next.add(host);
      await this.atomic(
        "hosts.json",
        JSON.stringify({ disabledHosts: [...next] }),
      );
      this.disabled = next;
      this.options.changed();
    });
    this.writes = job.catch(() => {});
    await job;
  }
  private async atomic(name: string, data: string) {
    const target = path.join(this.options.directory, name),
      temp = target + "." + randomUUID() + ".tmp";
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, target);
  }
  private async download(url: string): Promise<string> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.options.session.fetch(url, {
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(`Filter download failed: HTTP ${response.status}`);
      if (!response.body) throw new Error("Empty filter response");
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks: Buffer[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 12 * 1024 * 1024) {
          controller.abort();
          throw new Error("Filter response exceeds 12 MiB");
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      // Diagnostics name the public source host and network code, never URL queries.
      const message =
        error instanceof Error ? error.message : "Network request failed";
      const code = message.match(/(?:net::)?ERR_[A-Z_]+|HTTP \d{3}/)?.[0];
      const detail = controller.signal.aborted
        ? "Request timed out or was cancelled"
        : code || "Network request failed";
      throw new Error(`Filter source ${new URL(url).hostname}: ${detail}`);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
  private attach(engine: ElectronBlocker) {
    if (this.disposed) return;
    const request = engine.onBeforeRequest;
    engine.onBeforeRequest = (details, callback) => {
      const source =
        details.resourceType === "mainFrame"
          ? details.url
          : (details.webContentsId &&
              webContents.fromId(details.webContentsId)?.getURL()) ||
            details.referrer ||
            "";
      if (this.disabled.has(hostname(source))) callback({});
      else request(details, callback);
    };
    const headers = engine.onHeadersReceived;
    engine.onHeadersReceived = (details, callback) => {
      const source =
        details.resourceType === "mainFrame"
          ? details.url
          : (details.webContentsId &&
              webContents.fromId(details.webContentsId)?.getURL()) ||
            details.referrer ||
            "";
      if (this.disabled.has(hostname(source))) callback({});
      else headers(details, callback);
    };
    const cosmetic = engine.onInjectCosmeticFilters;
    engine.onInjectCosmeticFilters = async (event, url, message) => {
      if (
        event.sender.session !== this.options.session ||
        event.senderFrame !== event.sender.mainFrame
      )
        return;
      const actualUrl = event.sender.getURL();
      if (!this.disabled.has(hostname(actualUrl)))
        await cosmetic(event, actualUrl, message);
    };
    this.engine?.disableBlockingInSession(this.options.session);
    engine.enableBlockingInSession(this.options.session);
    this.engine = engine;
  }
  private async load() {
    await this.ready;
    if (this.disposed) return;
    const raw = process.env.COD_ADBLOCK_FILTER_LIST_URLS
      ? JSON.parse(process.env.COD_ADBLOCK_FILTER_LIST_URLS)
      : [...adsAndTrackingLists, baseList];
    if (!Array.isArray(raw) || !raw.length || raw.length > 32)
      throw new Error("Expected 1..32 filter list URLs");
    const urls = raw.map(checkedUrl),
      resource = checkedUrl(
        process.env.COD_ADBLOCK_RESOURCE_URL ?? resourceDefault,
      ),
      config = { sdk: "2.20.3", urls, resource },
      key = digest(JSON.stringify(config)),
      cacheName = `engine-${key}.json`;
    let cached = false;
    try {
      const filename = path.join(this.options.directory, cacheName);
      if ((await stat(filename)).size > 64 * 1024 * 1024)
        throw new Error("Engine cache exceeds limit");
      const value = JSON.parse(await readFile(filename, "utf8"));
      const bytes = Buffer.from(value.engine, "base64");
      if (value.key !== key || digest(bytes) !== value.sha256)
        throw new Error("Engine cache identity mismatch");
      this.attach(ElectronBlocker.deserialize(bytes));
      cached = true;
      this.blocking = { status: "ready", cached: true };
      this.resolveProtection();
      this.options.changed();
    } catch {
      /* A cache is optional; network failure remains explicit. */
    }
    try {
      const data = await Promise.all(
        [...urls, resource].map((url) => this.download(url)),
      );
      if (this.disposed) return;
      if (data.reduce((n, s) => n + Buffer.byteLength(s), 0) > 48 * 1024 * 1024)
        throw new Error("Combined filters exceed 48 MiB");
      const resources = data.pop()!;
      const engine = ElectronBlocker.parse(data.join("\n"));
      engine.updateResources(resources, digest(resources));
      const serialized = engine.serialize();
      const metadata = data.map((text, index) => ({
        url: urls[index],
        sha256: digest(text),
        header: text
          .split("\n")
          .filter((line) =>
            /^!\s*(Title|Version|Last modified|Homepage|License|Expires):/i.test(
              line,
            ),
          )
          .slice(0, 24),
        notice:
          "Locally fetched filter data; retain upstream source licensing.",
      }));
      await this.atomic(
        cacheName,
        JSON.stringify({
          key,
          config,
          sha256: digest(serialized),
          engine: Buffer.from(serialized).toString("base64"),
          fetchedAt: new Date().toISOString(),
          sources: metadata,
          resources: { url: resource, sha256: digest(resources) },
        }),
      );
      if (this.disposed) return;
      this.attach(engine);
      this.blocking = { status: "ready", cached: false };
    } catch (error) {
      if (this.disposed) return;
      this.blocking = {
        status: cached ? "ready" : "failed",
        cached,
        error: `${cached ? "Update failed; using last-known-good filters. " : "Blocking unavailable. "}${error instanceof Error ? error.message : String(error)}`,
      };
    }
    this.options.changed();
  }
  dispose() {
    this.disposed = true;
    this.resolveProtection();
    for (const controller of this.controllers) controller.abort();
    this.engine?.disableBlockingInSession(this.options.session);
  }
}
