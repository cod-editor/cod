import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { watchFile, unwatchFile } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  defaultSettings,
  validateSettings,
  type SettingsState,
} from "../settings.ts";
export class SettingsService {
  state: SettingsState;
  onChange?: (state: SettingsState) => void;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string) {
    this.state = {
      values: { ...defaultSettings },
      overrides: {},
      path: path.join(root, "settings.json"),
    };
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  async load(): Promise<SettingsState> {
    return this.serial(async () => {
      try {
        const content = await readFile(this.state.path, "utf8");
        if (content.length > 65536) throw new Error("Settings exceed 64 KiB");
        const overrides = validateSettings(JSON.parse(content));
        this.state = {
          path: this.state.path,
          overrides,
          values: { ...defaultSettings, ...overrides },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          this.state = {
            path: this.state.path,
            overrides: {},
            values: { ...defaultSettings },
          };
        else
          this.state = {
            ...this.state,
            error:
              error instanceof SyntaxError
                ? "Invalid JSON in settings.json"
                : error instanceof Error
                  ? error.message
                  : "Could not read settings",
          };
      }
      this.onChange?.(this.state);
      return this.state;
    });
  }
  update(patch: unknown, reset = false): Promise<SettingsState> {
    return this.serial(async () => {
      if (this.state.error)
        throw new Error("Fix settings.json before saving changes");
      let latest = this.state.overrides;
      try {
        const content = await readFile(this.state.path, "utf8");
        if (content.length > 65536) throw new Error("Settings exceed 64 KiB");
        latest = validateSettings(JSON.parse(content));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("Fix settings.json before saving changes");
        latest = {};
      }
      const overrides = reset ? {} : { ...latest, ...validateSettings(patch) };
      await mkdir(path.dirname(this.state.path), {
        recursive: true,
        mode: 0o700,
      });
      const temporary = `${this.state.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(overrides, null, 2) + "\n", {
        mode: 0o600,
      });
      await rename(temporary, this.state.path);
      this.state = {
        path: this.state.path,
        overrides,
        values: { ...defaultSettings, ...overrides },
      };
      this.onChange?.(this.state);
      return this.state;
    });
  }
  watch(): void {
    watchFile(this.state.path, { interval: 500, persistent: false }, () => {
      void this.load();
    });
  }
  dispose(): void {
    unwatchFile(this.state.path);
  }
}
