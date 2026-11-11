import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { searchEngines, type SearchEngine } from "./address.ts";
export interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: number;
}
interface LibraryData {
  history: HistoryEntry[];
  searchEngine: SearchEngine;
}
/** Browsing history is queried on demand, never copied into chat state updates. */
export class BrowserLibrary {
  private data: LibraryData = { history: [], searchEngine: "google" };
  private ready?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  private load() {
    return (this.ready ??= (async () => {
      try {
        const saved = JSON.parse(
          await readFile(
            path.join(this.directory, "browser-library.json"),
            "utf8",
          ),
        );
        if (
          !Array.isArray(saved.history) ||
          !searchEngines.includes(saved.searchEngine)
        )
          throw new Error("Invalid browser library");
        this.data = saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    })());
  }
  private change<T>(action: () => T): Promise<T> {
    const result = this.queue.then(async () => {
      await this.load();
      const before = structuredClone(this.data);
      try {
        const result = action();
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const temporary = path.join(
          this.directory,
          `browser-library-${randomUUID()}.tmp`,
        );
        await writeFile(temporary, JSON.stringify(this.data), { mode: 0o600 });
        await rename(
          temporary,
          path.join(this.directory, "browser-library.json"),
        );
        return result;
      } catch (error) {
        this.data = before;
        throw error;
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }
  async settings() {
    await this.queue;
    await this.load();
    return { searchEngine: this.data.searchEngine };
  }
  async configure(engine: string) {
    if (!searchEngines.includes(engine as SearchEngine))
      throw new Error(
        "Search engine must be google, duckduckgo, bing or yandex",
      );
    return this.change(() => {
      this.data.searchEngine = engine as SearchEngine;
      return { searchEngine: this.data.searchEngine };
    });
  }
  async visit(value: string, title: string) {
    const url = new URL(value);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      /(?:oauth|authorize|callback)/i.test(url.pathname) ||
      [...url.searchParams.keys()].some((key) =>
        /^(?:code|state|token|access_token|id_token|refresh_token)$/i.test(key),
      )
    )
      return;
    url.hash = "";
    return this.change(() => {
      this.data.history = [
        { url: url.href, title: title || url.hostname, visitedAt: Date.now() },
        ...this.data.history.filter((item) => item.url !== url.href),
      ].slice(0, 2000);
    });
  }
  async history(query = "", limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000)
      throw new Error("History limit must be between 1 and 2000");
    await this.queue;
    await this.load();
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return this.data.history
      .filter((item) =>
        terms.every((term) =>
          `${item.title} ${item.url}`.toLocaleLowerCase().includes(term),
        ),
      )
      .slice(0, Math.min(2000, Math.max(1, limit)))
      .map((item) => ({ ...item }));
  }
  forget(url?: string) {
    return this.change(() => {
      this.data.history = url
        ? this.data.history.filter((item) => item.url !== url)
        : [];
      return { removed: true };
    });
  }
  async flush() {
    await this.queue;
  }
}
