import { migrateProfile, profileIsLive } from "./profile-migration";
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
} from "electron";
import {
  chmod,
  lstat,
  unlink,
  readFile,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ApplicationOperations } from "./operations";
import {
  defaultDataDirectory,
  defaultSocketPath,
  legacyDataDirectory,
  ownershipLockDirectory,
} from "./paths";
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
    let workspace = operations.snapshot().activeWorkspaceId;
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
const defaultProfile =
  !process.env.COD_DATA_DIR &&
  !process.env.COD_SOCKET_PATH &&
  !app.commandLine.hasSwitch("user-data-dir");
// One canonical data-directory lock for both default and explicit-profile starts.
// Keep it for the whole lifetime; Chromium uses its own actual profile below.
const browserDataDirectory = app.commandLine.hasSwitch("user-data-dir")
  ? app.commandLine.getSwitchValue("user-data-dir")
  : path.join(dataDirectory, "chromium");
app.setPath("userData", ownershipLockDirectory(dataDirectory));
const ownsInstance = app.requestSingleInstanceLock();
if (ownsInstance) {
  try {
    if (defaultProfile)
      migrateProfile({
        directory: dataDirectory,
        legacyDirectory: legacyDataDirectory(),
      });
    if (profileIsLive(dataDirectory))
      throw new Error(
        "This Cod profile is already in use. Close its running Cod window before starting this version.",
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    dialog.showErrorBox("Could not open Cod", message);
    app.exit(1);
    throw error;
  }
  app.setPath("userData", browserDataDirectory);
}

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
  // Own the settings accelerator before DOM/menu dispatch so one physical key
  // produces one command. Menu clicks use the same trusted command event.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const match = resolveKeybinding(
      nativeKeyInput(input),
      process.platform === "darwin" ? "darwin" : "linux",
      "shell",
    );
    if (match?.command !== "settings") return;
    event.preventDefault();
    if (match.dispatch)
      mainWindow?.webContents.send("cod:command", { command: "settings" });
  });

  const browserSession = session.fromPartition("persist:cod-browser");
  browserSession.setPermissionRequestHandler(
    (contents, permission, callback) => {
      operations.browserPermissionDenied(contents.id, permission);
      callback(false);
    },
  );
  browserSession.setPermissionCheckHandler(() => false);
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
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  void mainWindow.loadFile(rendererPath);
}

async function prepareSocket(socketPath: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const details = await lstat(socketPath);
    if (!details.isSocket())
      throw new Error(`Socket path is not a socket: ${socketPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const live = await new Promise<boolean>((resolve, reject) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.end();
      resolve(true);
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
        resolve(false);
      else reject(error);
    });
  });
  if (live)
    throw new Error("Another Cod instance already controls this socket");
  await unlink(socketPath);
}

async function startCommandServer(): Promise<void> {
  const socketPath = defaultSocketPath();
  await prepareSocket(socketPath);
  commandServer = createServer((connection) => {
    connection.on("error", () => undefined);
    connection.setEncoding("utf8");
    let input = "";
    connection.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input) > 32 * 1024 * 1024) {
        connection.end(
          `${JSON.stringify({ ok: false, error: "Request too large" })}\n`,
        );
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = "";
      void (async () => {
        try {
          const request = JSON.parse(line) as OperationRequest;
          const result = await operations.dispatch(request);
          connection.end(`${JSON.stringify({ ok: true, result })}\n`);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          connection.end(`${JSON.stringify({ ok: false, error: message })}\n`);
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    commandServer!.once("error", reject);
    commandServer!.listen(socketPath, () => {
      commandServer!.off("error", reject);
      commandServer!.on("error", (error) => console.error(error));
      resolve();
    });
  });
  if (process.platform !== "win32") await chmod(socketPath, 0o600);
}

async function start(): Promise<void> {
  try {
    operations = new ApplicationOperations(dataDirectory);
    await operations.initialize();
    initialized = true;
    await startCommandServer();
    await app.whenReady();
    await reloadKeymap();
    watchFile(keymapPath, { interval: 500, persistent: false }, () => {
      void reloadKeymap();
    });
    app.once("will-quit", () => unwatchFile(keymapPath));
    const trustedKeymap = (event: Electron.IpcMainInvokeEvent) => {
      if (
        event.sender !== mainWindow?.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame ||
        event.senderFrame.url !== rendererUrl
      )
        throw new Error("Untrusted keymap request");
    };
    ipcMain.handle("cod:keymap", (event) => {
      trustedKeymap(event);
      return keymapState;
    });
    ipcMain.handle("cod:keymap-open", async (event) => {
      trustedKeymap(event);
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
    ipcMain.handle("cod:invoke", async (event, request: OperationRequest) => {
      if (
        event.sender !== mainWindow?.webContents ||
        event.senderFrame?.url !== rendererUrl
      ) {
        throw new Error("Operation rejected from an untrusted renderer");
      }
      return operations.dispatch(request, true);
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

if (ownsInstance) void start();
else app.quit();
app.on("window-all-closed", () => app.quit());
let quitting = false;
app.on("before-quit", (event) => {
  commandServer?.close();
  commandServer = null;
  if (initialized && !quitting) {
    event.preventDefault();
    void operations.shutdown().finally(() => {
      quitting = true;
      app.quit();
    });
  }
});
