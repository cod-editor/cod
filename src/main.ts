import { toggleDevTools } from "./devtools";
import os from "node:os";
import { DiagnosticJournal } from "./diagnostics";
import { startupBuildInfo } from "./build-info";
import {
  checkForPreviewUpdate,
  packagedPreviewTag,
  type PreviewUpdate,
} from "./preview-update";
import { watchFile, unwatchFile } from "node:fs";
import {
  nativeKeyInput,
  resolveKeybinding,
  formatShortcut,
  configureKeymap,
  type KeymapState,
} from "./keyboard";
import { registerAgentPageScheme } from "./agent-pages";
import { ElectronChromeExtensions } from "electron-chrome-extensions";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  session,
  protocol,
  dialog,
  shell,
  webContents,
  type WebContents,
} from "electron";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import type { Server } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ApplicationOperations } from "./operations";
import { BrowserApplicationService } from "./application/browser-service";
import { startCommandSocket } from "./application/command-socket";
import { defaultDataDirectory, defaultSocketPath } from "./paths";
import type { OperationRequest } from "./types";

registerAgentPageScheme([
  {
    scheme: "cod-preview",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const dataDirectory = defaultDataDirectory();
const runningBuild = startupBuildInfo(__dirname);
let runtimeJournal: DiagnosticJournal | undefined;
let operations: ApplicationOperations;
let initialized = false;
const keyboardPlatform = process.platform === "darwin" ? "darwin" : "linux";
const keymapPath = path.join(dataDirectory, "keymap.json");
let keymapState: KeymapState = { path: keymapPath, overrides: {} };
let refreshKeyboardMenu = () => {};
function settingsAccelerator(): string | undefined {
  return (
    formatShortcut("settings", keyboardPlatform)
      .replaceAll("⌘", "Command+")
      .replaceAll("⌃", "Ctrl+")
      .replaceAll("⌥", "Alt+")
      .replaceAll("⇧", "Shift+")
      .replace(/^Ctrl(?=[^+])/, "Ctrl+") || undefined
  );
}
async function reloadKeymap(): Promise<void> {
  try {
    const raw = await readFile(keymapPath, "utf8");
    if (raw.length > 65536) throw new Error("Keymap exceeds 64 KiB");
    keymapState = {
      path: keymapPath,
      overrides: configureKeymap(JSON.parse(raw), keyboardPlatform),
    };
  } catch (error) {
    configureKeymap({}, keyboardPlatform);
    keymapState = {
      path: keymapPath,
      overrides: {},
      ...((error as NodeJS.ErrnoException).code === "ENOENT"
        ? {}
        : {
            error:
              error instanceof Error ? error.message : "Cannot read keymap",
          }),
    };
  }
  refreshKeyboardMenu();
  mainWindow?.webContents.send("cod:keymap", keymapState);
}

let mainWindow: BrowserWindow | null = null;
let previewUpdate: PreviewUpdate | undefined;
function startPreviewChecks(): void {
  const current = packagedPreviewTag(
    app.isPackaged,
    process.platform,
    process.arch,
    app.getVersion(),
  );
  if (!current) return;
  const stop = new AbortController();
  const refresh = async () => {
    try {
      const update = await checkForPreviewUpdate(current, stop.signal);
      if (stop.signal.aborted || update?.version === previewUpdate?.version)
        return;
      previewUpdate = update;
      mainWindow?.webContents.send(
        "cod:preview-update",
        update?.version ?? null,
      );
    } catch {
      // The preview notice is optional. Keep the last successful result if the feed is unavailable.
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 6 * 60 * 60 * 1000);
  timer.unref();
  app.once("will-quit", () => {
    clearInterval(timer);
    stop.abort();
  });
}
let commandServer: Server | null = null;
const rendererPath = path.join(__dirname, "index.html");
const rendererUrl = pathToFileURL(rendererPath).href;

const pendingUrls: string[] = [];
let canOpenUrls = false;
async function openExternalUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (!["http:", "https:"].includes(url.protocol)) return;
  if (!canOpenUrls) {
    pendingUrls.push(url.href);
    return;
  }
  try {
    let workspace = operations.activeWorkspaceId;
    if (!workspace)
      workspace = (
        (await operations.dispatch(
          { op: "workspace.create", name: "Browsing" },
          true,
        )) as { id: string }
      ).id;
    await operations.dispatch(
      { op: "browser.open", workspace, url: url.href },
      true,
    );
    if (!mainWindow) createWindow();
    mainWindow?.show();
    mainWindow?.focus();
  } catch (error) {
    console.error(
      "Could not open external URL",
      error instanceof Error ? error.message : String(error),
    );
  }
}
app.on("open-url", (event, url) => {
  event.preventDefault();
  void openExternalUrl(url);
});
app.on("second-instance", (_event, argv) => {
  for (const argument of argv)
    if (/^https?:\/\//i.test(argument)) void openExternalUrl(argument);
});

app.setName("Cod");
if (!app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", path.join(dataDirectory, "chromium"));
}
const ownsInstance = app.requestSingleInstanceLock();

function createWindow(): void {
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession);
  mainWindow = new BrowserWindow({
    icon: path.join(__dirname, "cod-icon.png"),
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 500,
    backgroundColor: "#282c34",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: { x: 12, y: 10 },
        }
      : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Own native macOS close-tab and settings accelerators before DOM/menu
  // dispatch. Prevent the DOM duplicate, including when a preview frame has focus.
  // Linux Ctrl+W remains surface-specific (terminal readline owns that key).
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const match = resolveKeybinding(
      nativeKeyInput(input),
      process.platform === "darwin" ? "darwin" : "linux",
      "shell",
    );
    const ownsDevTools =
      match?.command === "devtools.toggle" &&
      resolveKeybinding(
        nativeKeyInput(input),
        process.platform === "darwin" ? "darwin" : "linux",
        "terminal",
      )?.command === "devtools.toggle";
    if (
      !match ||
      (!ownsDevTools &&
        match.command !== "settings" &&
        !(process.platform === "darwin" && match.command === "tab.close"))
    )
      return;
    event.preventDefault();
    if (match.dispatch) {
      if (ownsDevTools) toggleDevTools(mainWindow!.webContents);
      else
        mainWindow?.webContents.send("cod:command", { command: match.command });
    }
  });

  const browserSession = session.fromPartition("persist:cod-browser");
  operations.attachBrowserHost(
    mainWindow,
    browserSession,
    path.resolve(process.env.COD_DOWNLOAD_DIR ?? app.getPath("downloads")),
  );
  operations.attachAgentPageHost(
    mainWindow,
    session.fromPartition("cod-agent-pages"),
  );
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    // A window close precedes window-all-closed/before-quit. Enter durable
    // shutdown while native views still exist, rather than treating their
    // destruction as explicit tab-close events.
    if (initialized && !quitting) {
      event.preventDefault();
      app.quit();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    if (previewUpdate)
      mainWindow?.webContents.send("cod:preview-update", previewUpdate.version);
  });
  void mainWindow.loadFile(rendererPath);
}

async function start(): Promise<void> {
  try {
    operations = new ApplicationOperations(
      dataDirectory,
      runningBuild,
      (store, conversations) =>
        new BrowserApplicationService(store, conversations),
    );
    await operations.initialize();
    initialized = true;
    commandServer = await startCommandSocket(defaultSocketPath(), (request) =>
      operations.dispatch(request),
    );
    await app.whenReady();
    operations.settings.onChange = (value) =>
      mainWindow?.webContents.send("cod:settings", value);
    operations.settings.watch();
    app.once("will-quit", () => operations.settings.dispose());
    await reloadKeymap();
    watchFile(keymapPath, { interval: 500, persistent: false }, () => {
      void reloadKeymap();
    });
    app.once("will-quit", () => unwatchFile(keymapPath));
    const requireShellRenderer = (event: Electron.IpcMainInvokeEvent) => {
      if (
        event.sender !== mainWindow?.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame ||
        event.senderFrame.url !== rendererUrl
      )
        throw new Error("Untrusted renderer request");
    };
    ipcMain.handle("cod:preview-update-open", async (event) => {
      requireShellRenderer(event);
      if (previewUpdate) await shell.openExternal(previewUpdate.downloadUrl);
    });
    ipcMain.handle("cod:devtools", (event, id: unknown) => {
      if (
        event.sender !== mainWindow?.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== rendererUrl
      )
        throw new Error("Developer Tools rejected from an untrusted renderer");
      if (id === undefined) toggleDevTools(mainWindow.webContents);
      else {
        if (typeof id !== "string")
          throw new Error("Browser ID must be a string");
        operations.browserDevTools(id);
      }
    });
    ipcMain.handle("cod:settings-open", async (event) => {
      requireShellRenderer(event);
      if (!operations.settings.state.error)
        await operations.settings.update({});
      const error = await shell.openPath(operations.settings.state.path);
      if (error) throw new Error(error);
    });
    ipcMain.handle("cod:keymap", (event) => {
      requireShellRenderer(event);
      return keymapState;
    });
    ipcMain.handle("cod:keymap-open", async (event) => {
      requireShellRenderer(event);
      await mkdir(dataDirectory, { recursive: true });
      try {
        await writeFile(keymapPath, "{}\n", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const error = await shell.openPath(keymapPath);
      if (error) throw new Error(error);
    });
    if (process.platform === "darwin")
      app.dock?.setIcon(path.join(__dirname, "cod-icon.png"));
    protocol.handle("cod-preview", async (request) => {
      const url = new URL(request.url),
        asset = url.pathname.slice(1);
      if (
        request.method !== "GET" ||
        url.hostname !== "preview" ||
        !["preview.html", "preview.js", "preview.css"].includes(asset)
      )
        return new Response("Not found", { status: 404 });
      const content = await readFile(path.join(__dirname, asset));
      const type = asset.endsWith(".js")
        ? "text/javascript"
        : asset.endsWith(".css")
          ? "text/css"
          : "text/html";
      return new Response(content, {
        headers: { "Content-Type": type, "X-Content-Type-Options": "nosniff" },
      });
    });
    operations.onDidChange = (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("cod:state", state);
      }
    };
    operations.onDidTerminal = (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("cod:terminal", event);
      }
    };
    ipcMain.handle(
      "cod:browser-find",
      (event, id: unknown, text: unknown, options: unknown) => {
        if (
          event.sender !== mainWindow?.webContents ||
          event.senderFrame !== event.sender.mainFrame ||
          event.senderFrame.url !== rendererUrl ||
          typeof id !== "string" ||
          typeof text !== "string"
        )
          throw new Error("Search rejected from an untrusted renderer");
        if (options !== undefined && (!options || typeof options !== "object"))
          throw new Error("Invalid search options");
        const value = (options ?? {}) as {
          forward?: unknown;
          findNext?: unknown;
        };
        if (
          (value.forward !== undefined && typeof value.forward !== "boolean") ||
          (value.findNext !== undefined && typeof value.findNext !== "boolean")
        )
          throw new Error("Invalid search options");
        return operations.browserFind(
          id,
          text,
          value as { forward?: boolean; findNext?: boolean },
        );
      },
    );
    ipcMain.on("cod:browser-stop-find", (event, id: unknown) => {
      if (
        event.sender !== mainWindow?.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== rendererUrl ||
        typeof id !== "string"
      )
        return;
      operations.browserStopFind(id);
    });
    ipcMain.on("cod:browser-focus", (event, id: unknown) => {
      if (
        event.sender !== mainWindow?.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== rendererUrl ||
        typeof id !== "string"
      )
        return;
      operations.browserFocus(id);
    });
    ipcMain.on("cod:browser-select", (event, id: unknown) => {
      if (
        event.sender !== mainWindow?.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== rendererUrl ||
        typeof id !== "string"
      )
        return;
      operations.browserSelect(id);
    });
    ipcMain.on("cod:browser-layout", (event, rectangles) => {
      if (
        event.sender === mainWindow?.webContents &&
        event.senderFrame?.url === rendererUrl
      )
        operations.browserLayout(rectangles);
    });
    ipcMain.handle("cod:browser-overview-backdrop", (event, ids: unknown) => {
      if (
        event.sender !== mainWindow?.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== rendererUrl
      )
        return [];
      return operations.browserOverviewBackdrop(ids);
    });
    ipcMain.handle("cod:choose-directory", async (event) => {
      const parent = mainWindow;
      if (
        !parent ||
        event.sender !== parent.webContents ||
        event.senderFrame !== parent.webContents.mainFrame ||
        event.senderFrame.url !== rendererUrl
      ) {
        throw new Error(
          "Directory chooser rejected from an untrusted renderer",
        );
      }
      const result = await dialog.showOpenDialog(parent, {
        title: "Add folder to workspace",
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });
    ipcMain.handle(
      "cod:choose-save-file",
      async (event, workspace: string, paneId: string) => {
        const parent = mainWindow;
        if (
          !parent ||
          event.sender !== parent.webContents ||
          event.senderFrame !== parent.webContents.mainFrame ||
          event.senderFrame.url !== rendererUrl
        )
          throw new Error("Save chooser rejected from an untrusted renderer");
        const defaultPath = operations.fileSaveDefault(workspace, paneId);
        const result = await dialog.showSaveDialog(parent, {
          title: "Save file",
          defaultPath,
          properties: ["createDirectory", "showOverwriteConfirmation"],
        });
        return result.canceled || !result.filePath
          ? null
          : operations.fileSaveChoice(result.filePath);
      },
    );
    ipcMain.handle("cod:invoke", async (event, request: OperationRequest) => {
      if (
        event.sender !== mainWindow?.webContents ||
        event.senderFrame?.url !== rendererUrl
      ) {
        throw new Error("Operation rejected from an untrusted renderer");
      }
      const tracked = request.op === "pane.close";
      const started = Date.now();
      if (tracked) runtimeJournal?.record("close-tab-request");
      try {
        const result = await operations.dispatch(request, true);
        if (tracked)
          runtimeJournal?.record("close-tab-result", {
            elapsedMs: Date.now() - started,
            closed: (result as { closed?: boolean })?.closed !== false,
          });
        return result;
      } catch (error) {
        if (tracked)
          runtimeJournal?.record("close-tab-error", {
            elapsedMs: Date.now() - started,
          });
        throw error;
      }
    });
    const settingsItem: Electron.MenuItemConstructorOptions = {
      id: "settings",
      label: "Settings...",
      accelerator: settingsAccelerator(),
      click: () =>
        mainWindow?.webContents.send("cod:command", { command: "settings" }),
    };
    const template: Electron.MenuItemConstructorOptions[] =
      process.platform === "darwin"
        ? [
            {
              label: app.name,
              submenu: [settingsItem, { type: "separator" }, { role: "quit" }],
            },
            { role: "editMenu" },
          ]
        : [
            {
              label: "File",
              submenu: [settingsItem, { type: "separator" }, { role: "quit" }],
            },
            {
              label: "Edit",
              submenu: [
                { role: "copy", accelerator: "Ctrl+Shift+C" },
                { role: "paste", accelerator: "Ctrl+Shift+V" },
              ],
            },
          ];
    refreshKeyboardMenu = () => {
      settingsItem.accelerator = settingsAccelerator();
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    };
    refreshKeyboardMenu();
    createWindow();
    startPreviewChecks();
    canOpenUrls = true;
    for (const url of [
      ...pendingUrls.splice(0),
      ...process.argv.filter((argument) => /^https?:\/\//i.test(argument)),
    ])
      void openExternalUrl(url);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

if (ownsInstance) {
  const journal = new DiagnosticJournal(dataDirectory);
  runtimeJournal = journal;
  journal.start(app.getVersion(), runningBuild);
  const contexts = new Map<
    number,
    {
      id: number;
      pid: number;
      type: string;
      role: string;
      browserId?: string;
      workspaceId?: string;
    }
  >();
  const contentContext = (contents: WebContents) => {
    const previous = contexts.get(contents.id);
    const unavailable = previous ?? {
      id: contents.id,
      pid: 0,
      type: "unavailable",
      role: "unknown",
    };
    if (contents.isDestroyed()) return unavailable;
    try {
      const owner = operations?.diagnosticContext(contents.id);
      const context = {
        id: contents.id,
        pid: contents.getOSProcessId() || previous?.pid || 0,
        type: contents.getType(),
        role:
          owner?.role ??
          (mainWindow &&
          !mainWindow.isDestroyed() &&
          contents === mainWindow.webContents
            ? "application"
            : contents.getType()),
        ...(owner
          ? { browserId: owner.browserId, workspaceId: owner.workspaceId }
          : {}),
      };
      contexts.set(contents.id, context);
      return context;
    } catch {
      return unavailable;
    }
  };
  const sample = () => {
    try {
      journal.record("memory", {
        main: process.memoryUsage(),
        freeSystemBytes: os.freemem(),
        totalSystemBytes: os.totalmem(),
        contents: webContents.getAllWebContents().map(contentContext),
        processes: app.getAppMetrics().map((metric) => ({
          pid: metric.pid,
          type: metric.type,
          memory: metric.memory,
          cpuPercent: metric.cpu.percentCPUUsage,
        })),
      });
    } catch {
      journal.record("memory-sample-unavailable");
    }
  };
  void app.whenReady().then(() => {
    sample();
    const timer = setInterval(sample, 30_000);
    timer.unref();
    app.once("will-quit", () => {
      clearInterval(timer);
      sample();
      journal.stop();
    });
  });
  app.on("web-contents-created", (_event, contents) => {
    const updateContext = () => {
      const previous = contexts.get(contents.id);
      const current = contentContext(contents);
      if (JSON.stringify(previous) !== JSON.stringify(current))
        journal.record("renderer-context", current);
    };
    contents.on("dom-ready", updateContext);
    contents.on("did-finish-load", updateContext);
    contents.once("destroyed", () => {
      const context = contexts.get(contents.id);
      if (context) journal.record("renderer-destroyed", context);
      contexts.delete(contents.id);
    });
    contents.on("before-input-event", (_event, input) => {
      // Only the close chord, never arbitrary text or URLs.
      if (
        input.type !== "keyDown" ||
        input.isAutoRepeat ||
        (!input.meta && !input.control) ||
        (input.code !== "KeyW" && input.key.toLowerCase() !== "w")
      )
        return;
      journal.record("close-tab-key", {
        id: contents.id,
        type: contents.getType(),
        meta: input.meta,
        control: input.control,
        shift: input.shift,
        alt: input.alt,
        composing: !!input.isComposing,
        command:
          resolveKeybinding(
            nativeKeyInput(input),
            process.platform === "darwin" ? "darwin" : "linux",
            "shell",
          )?.command ?? null,
      });
    });
    contents.on("render-process-gone", (_event, details) => {
      journal.record("renderer-gone", {
        ...contentContext(contents),
        reason: details.reason,
        exitCode: details.exitCode,
      });
    });
    contents.on("unresponsive", () =>
      journal.record("unresponsive", contentContext(contents)),
    );
    contents.on("responsive", () =>
      journal.record("responsive", contentContext(contents)),
    );
  });
  app.on("child-process-gone", (_event, details) =>
    journal.record("child-gone", {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    }),
  );
  // Observe fatal exceptions without suppressing Node's normal fatal exit.
  process.on("uncaughtExceptionMonitor", (_error, origin) =>
    journal.record("fatal-exception", { origin }),
  );
}
if (ownsInstance) void start();
else app.quit();
app.on("window-all-closed", () => app.quit());
let quitting = false;
let shutdown: Promise<void> | undefined;
app.on("before-quit", (event) => {
  commandServer?.close();
  commandServer = null;
  if (initialized && !quitting) {
    event.preventDefault();
    shutdown ??= operations.shutdown().finally(() => {
      quitting = true;
      app.quit();
    });
  }
});
