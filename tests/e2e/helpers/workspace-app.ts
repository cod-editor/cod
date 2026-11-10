import {
  _electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createServer, type Server } from "node:http";

const execute = promisify(execFile);
export const modifier = process.platform === "darwin" ? "Meta" : "Control";
export interface PaneState {
  id: string;
  [key: string]: unknown;
}
export interface WorkspaceState {
  id: string;
  name: string;
  folders: unknown[];
  panes: PaneState[];
  activePaneId: string;
  layout: unknown;
}
export interface AppState {
  workspaces: WorkspaceState[];
  activeWorkspaceId: string | null;
}
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class WorkspaceApp {
  root = process.cwd();
  temporary = "";
  data = "";
  socket = "";
  folders: string[] = [];
  file = "";
  app?: ElectronApplication;
  page!: Page;
  environment: Record<string, string> = {};
  launchArguments: string[] = [];
  private filterServer?: Server;

  async prepare() {
    // A short path also stays within macOS Unix-domain socket path limits.
    this.temporary = await mkdtemp(path.join(os.tmpdir(), "cod-e2e-"));
    this.data = path.join(this.temporary, "data");
    this.socket = path.join(this.temporary, "app.sock");
    this.folders = [
      path.join(this.temporary, "alpha repo"),
      path.join(this.temporary, "beta repo"),
    ];
    for (const folder of this.folders) {
      await mkdir(folder, { recursive: true });
      await execute("git", ["init", "--quiet", folder]);
    }
    this.file = path.join(this.folders[0], "spec.md");
    await writeFile(this.file, "# Invented specification\n\nInitial text.\n");
    // Use the actual integrated blocker with deterministic public fixture data.
    // General application tests must not depend on public filter-list latency.
    this.filterServer = createServer((request, response) => {
      response.setHeader(
        "Content-Type",
        request.url === "/resources" ? "application/json" : "text/plain",
      );
      response.end(
        request.url === "/resources"
          ? JSON.stringify({ scriptlets: [], redirects: [] })
          : "[Adblock Plus 2.0]\n! Title: Invented acceptance rules\n/never-used-invented-ad.js$script\n",
      );
    });
    await new Promise<void>((resolve) =>
      this.filterServer!.listen(0, "127.0.0.1", resolve),
    );
    const address = this.filterServer.address();
    if (!address || typeof address === "string")
      throw new Error("Filter fixture unavailable");
    const filterOrigin = `http://127.0.0.1:${address.port}`;
    this.environment = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      COD_DATA_DIR: this.data,
      COD_SOCKET_PATH: this.socket,
      COD_ADBLOCK_FILTER_LIST_URLS: JSON.stringify([filterOrigin + "/filters"]),
      COD_ADBLOCK_RESOURCE_URL: filterOrigin + "/resources",
      COD_BITWARDEN_EXTENSION_PATH: path.join(
        this.temporary,
        "no-extension-fixture",
      ),
    };
  }

  async start() {
    // Missing scaffold is an execution prerequisite, not an application behavior assertion.
    await access(path.join(this.root, "dist/main.cjs"));
    await access(path.join(this.root, "dist/cli.cjs"));
    this.app = await _electron.launch({
      args: [
        path.join(this.root, "dist/main.cjs"),
        ...this.launchArguments,
        `--user-data-dir=${path.join(this.temporary, "chromium")}`,
      ],
      cwd: this.root,
      env: this.environment,
      chromiumSandbox: true,
    });
    // Restored native browser views can appear before the trusted app renderer.
    const rendererUrl = pathToFileURL(
      path.join(this.root, "dist/index.html"),
    ).href;
    await expect
      .poll(() => {
        const page = this.app!.context()
          .pages()
          .find(
            (candidate) =>
              !candidate.isClosed() && candidate.url() === rendererUrl,
          );
        if (page) this.page = page;
        return Boolean(page);
      })
      .toBe(true);
    await this.page
      .getByRole("button", { name: "Switch workspace", exact: true })
      .waitFor();
    await expect.poll(async () => (await this.raw("state")).code).toBe(0);
  }

  async stop() {
    if (this.app) {
      await this.app.close();
      this.app = undefined;
    }
  }

  async cleanup() {
    await this.stop();
    await new Promise<void>((resolve) =>
      this.filterServer ? this.filterServer.close(() => resolve()) : resolve(),
    );
    await rm(this.temporary, { recursive: true, force: true });
  }

  async raw(...args: string[]): Promise<CliResult> {
    try {
      const result = await execute(
        process.execPath,
        [path.join(this.root, "dist/cli.cjs"), ...args],
        {
          cwd: this.root,
          env: this.environment,
          timeout: 10000,
        },
      );
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const result = error as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      if (typeof result.code !== "number") throw error;
      return {
        code: result.code,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    }
  }

  async cli<T = Record<string, unknown>>(...args: string[]): Promise<T> {
    const result = await this.raw(...args);
    expect(result.code, `${args.join(" ")}\n${result.stderr}`).toBe(0);
    // JSON.parse rejects extra stdout logging and enforces the one-result CLI contract.
    return JSON.parse(result.stdout) as T;
  }

  state() {
    return this.cli<AppState>("state");
  }
  async workspace(id: string) {
    const item = (await this.state()).workspaces.find(
      (workspace) => workspace.id === id,
    );
    if (!item) throw new Error(`Workspace not found: ${id}`);
    return item;
  }
  async create(name: string) {
    const id = (
      await this.cli<{ id: string }>("workspace", "create", "--name", name)
    ).id;
    await this.cli("workspace", "focus", "--id", id);
    return id;
  }
  async command(name: string) {
    await this.page.keyboard.press(`${modifier}+Shift+P`);
    const dialog = this.page.getByRole("dialog");
    await dialog.getByRole("textbox").fill(name);
    await dialog.getByRole("button", { name, exact: true }).click();
  }
  row(name: string) {
    return this.page.getByRole("treeitem", {
      name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    });
  }
  pane(id: string) {
    return this.page
      .getByTestId("pane")
      .and(this.page.locator(`[data-pane-id=${JSON.stringify(id)}]`));
  }
  async contents() {
    return readFile(this.file, "utf8");
  }
}

/** Reach a control through real sequential keyboard navigation, never locator.focus(). */
export async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 80; step++) {
    if (
      await target
        .evaluate((element) => element === document.activeElement)
        .catch(() => false)
    )
      return;
    await page.keyboard.press("Tab");
  }
  throw new Error(
    `Control is not reachable with Tab: ${(await target.getAttribute("aria-label")) ?? (await target.textContent())}`,
  );
}
