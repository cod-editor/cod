import { toggleDevTools } from "./devtools";
import os from "node:os";
import { DiagnosticJournal } from "./diagnostics";
import { startupBuildInfo } from "./build-info";
import {
  checkForReleaseUpdate,
  packagedReleaseTag,
  releaseImage,
  type ReleaseUpdate,
  type ReleaseUpdateNotice,
} from "./release-update";
import { ReleaseInstaller } from "./release-install";
import {
  installedApplication,
  macReleaseDesktop,
} from "./release-update-macos";
import { watchFile, unwatchFile } from "node:fs";
import {
  nativeKeyInput,
  isCloseCommand,
  resolveKeybinding,
  formatShortcut,
  configureKeymap,
  type CommandId,
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
  WebContentsView,
  type WebContents,
} from "electron";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import type { Server } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ApplicationOperations } from "./operations";
import { desktopWorkspaceOperations } from "./command-catalog";
import { BrowserApplicationService } from "./application/browser-service";
import { startCommandSocket } from "./application/command-socket";
import {
  workspacePreparation,
  type PreparedWorkspace,
} from "./application/workspace-preparation";
import { defaultDataDirectory, defaultSocketPath } from "./paths";
import type {
  AppState,
  BrowserLayout,
  BrowserModalCover,
  ShellMenuItem,
  OperationRequest,
} from "./types";
import {
  canUsePairedDesktop,
  type WorkspaceHostSelection,
} from "./remote-workspace/protocol";
import { attachWorkspaceHost, type HostLink } from "./remote-workspace/client";
import {
  readWorkspaceHostTarget,
  stageWorkspaceHostTarget,
  workspaceHostSelection,
} from "./remote-workspace/target";
import {
  combineWorkspaces,
  requestBelongsToHost,
  validateRemoteRequest,
} from "./remote-workspace/view";

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
function menuAccelerator(command: CommandId): string | undefined {
  return (
    formatShortcut(command, keyboardPlatform)
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
let releaseUpdate: ReleaseUpdate | undefined;
let releaseNotice: ReleaseUpdateNotice | null = null;
let releaseInstaller: ReleaseInstaller | undefined;
let releaseStop: AbortSignal | undefined;
let releaseWork: Promise<void> | undefined;
function publishReleaseNotice(
  status: ReleaseUpdateNotice["status"] = "available",
) {
  releaseNotice = releaseUpdate
    ? { version: releaseUpdate.version, status }
    : null;
  mainWindow?.webContents.send("cod:release-update", releaseNotice);
}
function openReleaseUpdate(): Promise<void> | undefined {
  const update = releaseUpdate;
  if (!update || !releaseInstaller || !releaseStop) return;
  if (!update.sha256)
    return shell.openExternal(releaseImage(update.version).releaseUrl);
  if (releaseWork) return releaseWork;
  publishReleaseNotice("downloading");
  releaseWork = releaseInstaller
    .open(update, releaseStop)
    .then(
      () => publishReleaseNotice("ready"),
      (error) => {
        publishReleaseNotice("retry");
        throw error;
      },
    )
    .finally(() => {
      releaseWork = undefined;
    });
  return releaseWork;
}
function startReleaseChecks(): void {
  const version = app.getVersion();
  const current = packagedReleaseTag(
    app.isPackaged,
    process.platform,
    process.arch,
    version,
  );
  if (!current) return;
  const stop = new AbortController();
  const installer = new ReleaseInstaller(
    app.getPath("userData"),
    macReleaseDesktop((file) => shell.openPath(file)),
  );
  releaseInstaller = installer;
  releaseStop = stop.signal;
  mainWindow?.webContents.once("did-finish-load", () => {
    void installedApplication(process.execPath, os.homedir())
      .then((installed) =>
        installed ? installer.cleanup(version, process.execPath) : undefined,
      )
      .catch(() => {});
  });
  const refresh = async () => {
    try {
      const update = await checkForReleaseUpdate(current, stop.signal);
      if (
        stop.signal.aborted ||
        releaseWork ||
        (update?.version === releaseUpdate?.version &&
          update?.sha256 === releaseUpdate?.sha256 &&
          update?.size === releaseUpdate?.size)
      )
        return;
      const status = !update
        ? "available"
        : !update.sha256
          ? "manual"
          : (await installer.ready(update))
            ? "ready"
            : "available";
      if (stop.signal.aborted || releaseWork) return;
      releaseUpdate = update;
      publishReleaseNotice(status);
    } catch {
      // Keep the last successful notice when the release feed is unavailable.
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
let remoteWorkspace: HostLink | undefined;
let remoteView: string | undefined;
let attachingWorkspace: AbortController | undefined;
let displayedWorkspace: string | null = null;
let workspaceNavigation = 0;
let pendingWorkspace:
  { link: HostLink; id: string; navigation: number } | undefined;

function displayState(local = operations.snapshot(true)): AppState {
  const link = remoteWorkspace;
  if (!link) return local;
  return combineWorkspaces(local, {
    state: link.state,
    alias: link.selection.alias,
    connected: link.connected,
    reviewAccess: link.reviewAccess,
    viewing: remoteView,
  });
}

function showWorkspaceState(local?: AppState) {
  const state = displayState(local);
  if (state.activeWorkspaceId !== displayedWorkspace) {
    displayedWorkspace = state.activeWorkspaceId;
    workspaceNavigation++;
  }
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send("cod:state", state);
}

function quickTerminalCompanionHost(link: HostLink): string {
  return JSON.stringify([link.selection.alias, link.selection.socketPath]);
}

function reconcileQuickTerminalCompanions(link: HostLink) {
  if (link.connected)
    void operations
      .closeRemovedQuickTerminalCompanions(
        quickTerminalCompanionHost(link),
        link.state,
      )
      .catch((error) =>
        console.error("Could not close a Quick Terminal companion", error),
      );
}

function followPreparedWorkspace(link: HostLink) {
  const pending = pendingWorkspace;
  if (!pending || pending.link !== link) return;
  if (pending.navigation !== workspaceNavigation || !link.connected) {
    pendingWorkspace = undefined;
    return;
  }
  if (link.state.workspaces.some((workspace) => workspace.id === pending.id)) {
    pendingWorkspace = undefined;
    remoteView = pending.id;
    operations.clearBrowserPresentation();
  }
}

async function connectRemoteWorkspace(
  selection: WorkspaceHostSelection,
  { select = true, remember = false } = {},
): Promise<HostLink> {
  if (attachingWorkspace)
    throw new Error("A Linux workspace connection is in progress");
  const attempt = new AbortController();
  attachingWorkspace = attempt;
  try {
    const link = await attachWorkspaceHost(
      selection,
      (link, frame) => {
        if (remoteWorkspace !== link) return;
        if (frame?.type === "terminal")
          mainWindow?.webContents.send("cod:terminal", frame.value);
        else {
          const follow = frame?.type === "state" ? frame.follow : undefined;
          if (
            follow &&
            remoteView === follow.fromWorkspace &&
            link.state.activeWorkspaceId === follow.workspace &&
            link.state.conversations.some(
              (chat) =>
                chat.workspaceId === follow.workspace &&
                chat.id === follow.conversation,
            )
          ) {
            pendingWorkspace = undefined;
            remoteView = follow.workspace;
          }
          if (
            !link.state.workspaces.some(
              (workspace) => workspace.id === remoteView,
            )
          )
            remoteView = undefined;
          if (frame?.type === "state") reconcileQuickTerminalCompanions(link);
          followPreparedWorkspace(link);
          showWorkspaceState();
        }
      },
      attempt.signal,
    );
    let staged:
      Awaited<ReturnType<typeof stageWorkspaceHostTarget>> | undefined;
    try {
      attempt.signal.throwIfAborted();
      if (shutdown || quitting) throw new Error("Cod is shutting down");
      combineWorkspaces(operations.snapshot(true), {
        state: link.state,
        alias: link.selection.alias,
        connected: link.connected,
        reviewAccess: link.reviewAccess,
      });
      if (remember)
        staged = await stageWorkspaceHostTarget(dataDirectory, selection);
      attempt.signal.throwIfAborted();
      if (shutdown || quitting || !link.connected)
        throw new Error("The Linux workspace connection closed");
      // Publish the remembered destination and live link in the same turn.
      staged?.commit();
    } catch (error) {
      link.close();
      await staged?.discard();
      throw error;
    }
    remoteWorkspace?.close();
    pendingWorkspace = undefined;
    remoteWorkspace = link;
    reconcileQuickTerminalCompanions(link);
    if (select) remoteView = link.state.activeWorkspaceId ?? undefined;
    else if (!link.state.workspaces.some(({ id }) => id === remoteView))
      remoteView = undefined;
    if (remoteView) operations.clearBrowserPresentation();
    showWorkspaceState();
    return link;
  } finally {
    if (attachingWorkspace === attempt) attachingWorkspace = undefined;
  }
}

async function prepareDesktopWorkspace(request: OperationRequest) {
  const task = workspacePreparation(
    request,
    operations.settings.state.values["workspace.defaultHost"],
  );
  const navigation = ++workspaceNavigation;
  if (task.location === "linux") {
    if (task.conversation)
      throw new Error(
        "A desktop conversation cannot move to a Linux workspace",
      );
    let link = remoteWorkspace;
    if (!link?.connected) {
      const target =
        link?.selection ?? (await readWorkspaceHostTarget(dataDirectory));
      if (!target)
        throw new Error(
          "Connect to a Linux workspace from Commands or codctl before preparing a task on Linux",
        );
      try {
        link = await connectRemoteWorkspace(target, { select: false });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `Could not connect to the Linux workspace host "${target.alias}": ${reason}`,
          { cause },
        );
      }
    }
    const prepared = (await link.invoke({
      op: "workspace.prepare",
      ...task,
    })) as PreparedWorkspace;
    if (remoteWorkspace === link && navigation === workspaceNavigation) {
      pendingWorkspace = { link, id: prepared.id, navigation };
      followPreparedWorkspace(link);
      showWorkspaceState();
    }
    return prepared;
  }

  if (task.conversation)
    await operations.dispatch({
      op: "context",
      conversation: task.conversation,
    });
  const prepared = (await operations.dispatch({
    op: "workspace.prepare",
    ...task,
  })) as PreparedWorkspace;
  if (task.conversation) {
    await operations.dispatch({
      op: "conversation.move",
      id: task.conversation,
      workspace: prepared.id,
      follow: false,
    });
  }
  if (navigation === workspaceNavigation) {
    if (task.conversation)
      await operations.dispatch({
        op: "conversation.show",
        id: task.conversation,
      });
    else await operations.dispatch({ op: "workspace.focus", id: prepared.id });
    if (remoteView && navigation === workspaceNavigation) {
      remoteView = undefined;
      showWorkspaceState();
    }
  }
  return { ...prepared, location: task.location };
}

async function connectWorkspaceFromCommand(
  request: OperationRequest,
  allowReviewKey: boolean,
) {
  let selection: WorkspaceHostSelection;
  if (request.op === "workspace.reconnect") {
    const previous =
      remoteWorkspace?.selection ??
      (await readWorkspaceHostTarget(dataDirectory));
    if (!previous) throw new Error("Connect to a Linux workspace first");
    selection = previous;
  } else {
    selection = workspaceHostSelection({
      alias:
        typeof request.alias === "string"
          ? request.alias.trim()
          : request.alias,
      socketPath: request.socketPath,
      publicKey: allowReviewKey ? request.publicKey : undefined,
    });
  }
  const link = await connectRemoteWorkspace(selection, {
    remember: request.op === "workspace.connect",
  });
  return {
    alias: link.selection.alias,
    workspaceId: link.state.activeWorkspaceId ?? null,
    reviewAccess: link.reviewAccess,
  };
}

async function displayCommand(request: OperationRequest): Promise<unknown> {
  const link = remoteWorkspace;
  if (request.op === "state") return displayState();
  if (request.op === "workspace.prepare")
    return prepareDesktopWorkspace(request);
  if (request.op === "conversation.accept-transfer")
    throw new Error(
      "A native session can only be sent by an explicit conversation move",
    );
  if (request.op === "conversation.transfer") {
    if (!link?.connected || !link.reviewAccess)
      throw new Error(
        "Connect and pair with the Linux workspace to move this chat",
      );
    if (
      typeof request.id !== "string" ||
      typeof request.workspace !== "string" ||
      typeof request.cwd !== "string"
    )
      throw new Error(
        "Choose the conversation, Linux workspace, and its folder",
      );
    const workspace = link.state.workspaces.find(
      (item) => item.id === request.workspace,
    );
    if (!workspace?.folders.includes(request.cwd))
      throw new Error("Choose a folder attached to the Linux workspace");
    const navigation = workspaceNavigation;
    const receipt = await operations.transfers.move(
      request.id,
      { host: link.selection.alias, workspace: workspace.id, cwd: request.cwd },
      (operation) => link.invoke(operation),
    );
    if (remoteWorkspace === link && navigation === workspaceNavigation) {
      try {
        await link.invoke({ op: "conversation.show", id: receipt.id });
        if (remoteWorkspace === link && navigation === workspaceNavigation) {
          pendingWorkspace = { link, id: workspace.id, navigation };
          followPreparedWorkspace(link);
          showWorkspaceState();
        }
      } catch {
        // The move is already confirmed. The destination may be opened after reconnecting.
      }
    }
    return receipt;
  }
  if (
    request.op === "workspace.connect" ||
    request.op === "workspace.reconnect"
  )
    return connectWorkspaceFromCommand(request, true);
  if (request.op === "remote.target")
    return readWorkspaceHostTarget(dataDirectory);
  if (request.op === "remote.cancel") {
    attachingWorkspace?.abort();
    return;
  }
  if (request.op === "remote.disconnect") {
    attachingWorkspace?.abort();
    link?.close();
    remoteWorkspace = undefined;
    pendingWorkspace = undefined;
    remoteView = undefined;
    showWorkspaceState();
    return;
  }
  if (request.op === "remote.reconnect-current") {
    if (!link || !remoteView)
      throw new Error("Select a Linux workspace to reconnect");
    await connectRemoteWorkspace(link.selection, { select: false });
    return;
  }
  if (request.op === "terminal.quick-open" && request.location === "local") {
    if (link && requestBelongsToHost(link.state, request)) {
      if (
        typeof request.workspace !== "string" ||
        request.workspace !== remoteView
      )
        throw new Error(
          "Select the Linux workspace before opening its Local shell",
        );
      return operations.openQuickTerminalCompanion(
        request.workspace,
        quickTerminalCompanionHost(link),
      );
    }
    return operations.dispatch(request, true);
  }
  if (
    request.op === "terminal.quick-open" &&
    request.location === "linux" &&
    (!link || !requestBelongsToHost(link.state, request))
  )
    throw new Error("Reconnect to the Linux workspace first");
  if (link && requestBelongsToHost(link.state, request)) {
    if (
      request.op === "browser.open" &&
      typeof request.url === "string" &&
      /^https?:\/\//i.test(request.url)
    )
      return openExternalUrl(request.url);
    if (canUsePairedDesktop(request) && request.op !== "conversation.send")
      return link.invoke(request);
    validateRemoteRequest(request);
    if (request.op === "workspace.focus") {
      if (link.connected) await link.invoke(request);
      if (remoteWorkspace === link) {
        remoteView = String(request.id);
        operations.clearBrowserPresentation();
        showWorkspaceState();
      }
      return;
    }
    return link.invoke(
      request.op === "conversation.send" && !link.reviewAccess
        ? { ...request, requireIdle: true }
        : request,
    );
  }
  if (
    remoteView &&
    /^(conversation|terminal|project|git|file|pane|group|review)\./.test(
      request.op,
    ) &&
    !requestBelongsToHost(operations.snapshot(true), request)
  )
    throw new Error("Select a tab or workspace for this operation");
  const navigation = workspaceNavigation;
  const result = await operations.dispatch(request, true);
  if (
    remoteView &&
    (["workspace.focus", "workspace.create", "workspace.reopen"].includes(
      request.op,
    ) ||
      (request.op === "page.open" && navigation === workspaceNavigation))
  ) {
    remoteView = undefined;
    showWorkspaceState();
  }
  return result;
}

const rendererPath = path.join(__dirname, "index.html");
const rendererUrl = pathToFileURL(rendererPath).href;

const pendingUrls: string[] = [];
let canOpenUrls = false;
async function openExternalUrl(raw: string): Promise<unknown> {
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
    const result = await operations.dispatch(
      { op: "browser.open", workspace, url: url.href },
      true,
    );
    if (remoteView) {
      remoteView = undefined;
      showWorkspaceState();
    }
    if (!mainWindow) createWindow();
    mainWindow?.show();
    mainWindow?.focus();
    return result;
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
  // Own native macOS tab-closing and settings accelerators before DOM/menu
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
        !(process.platform === "darwin" && isCloseCommand(match.command)))
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
  mainWindow.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument)
      operations.clearBrowserPresentation();
  });
  mainWindow.webContents.on("render-process-gone", () =>
    operations.clearBrowserPresentation(),
  );
  mainWindow.webContents.on("did-finish-load", () => {
    if (releaseNotice)
      mainWindow?.webContents.send("cod:release-update", releaseNotice);
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
    displayedWorkspace = operations.activeWorkspaceId;
    commandServer = await startCommandSocket(defaultSocketPath(), (request) => {
      if (request?.op === "workspace.prepare")
        return prepareDesktopWorkspace(request);
      if (desktopWorkspaceOperations.has(request?.op))
        return connectWorkspaceFromCommand(request, false);
      if (
        request?.op === "conversation.transfer" ||
        request?.op === "page.open"
      )
        return displayCommand(request);
      return operations.dispatch(request);
    });
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
    ipcMain.handle("cod:release-update-open", async (event) => {
      requireShellRenderer(event);
      await openReleaseUpdate();
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
    operations.onDidChange = showWorkspaceState;
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
    ipcMain.on(
      "cod:browser-find-visibility",
      (event, id: unknown, visible: unknown) => {
        if (
          event.sender === mainWindow?.webContents &&
          event.senderFrame === event.sender.mainFrame &&
          event.senderFrame.url === rendererUrl &&
          typeof id === "string" &&
          typeof visible === "boolean"
        )
          operations.browserFindVisibility(id, visible);
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
    ipcMain.on("cod:browser-layout", (event, layout: BrowserLayout) => {
      if (
        event.sender === mainWindow?.webContents &&
        event.senderFrame === event.sender.mainFrame &&
        event.senderFrame.url === rendererUrl &&
        !remoteView &&
        layout &&
        Array.isArray(layout.rectangles)
      )
        operations.browserLayout(layout);
    });
    let activeShellMenu: Menu | undefined;
    ipcMain.handle(
      "cod:shell-menu",
      (event, anchor: { x: number; y: number }, items: ShellMenuItem[]) => {
        const window = mainWindow;
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== event.sender.mainFrame ||
          event.senderFrame.url !== rendererUrl ||
          !anchor ||
          !Number.isFinite(anchor.x) ||
          !Number.isFinite(anchor.y) ||
          !Array.isArray(items) ||
          items.length > 128 ||
          !items.every(
            (item) =>
              item === null ||
              (item &&
                typeof item.label === "string" &&
                item.label.length <= 512 &&
                typeof item.shortcut === "string" &&
                item.shortcut.length <= 60 &&
                typeof item.disabled === "boolean" &&
                (item.selected === undefined ||
                  typeof item.selected === "boolean") &&
                (item.title === undefined ||
                  (typeof item.title === "string" &&
                    item.title.length <= 512))),
          )
        )
          return null;
        const [width, height] = window.getContentSize();
        const x = Math.round(Math.max(0, Math.min(width - 1, anchor.x)));
        const y = Math.round(Math.max(0, Math.min(height - 1, anchor.y)));
        activeShellMenu?.closePopup(window);
        return new Promise<number | null>((resolve) => {
          const menu = Menu.buildFromTemplate(
            items.map((item, index) =>
              item
                ? {
                    label: item.shortcut
                      ? `${item.label}    ${item.shortcut}`
                      : item.label,
                    type: item.selected === undefined ? "normal" : "checkbox",
                    checked: item.selected,
                    toolTip: item.title,
                    enabled: !item.disabled,
                    click: () => resolve(index),
                  }
                : { type: "separator" },
            ),
          );
          activeShellMenu = menu;
          menu.popup({
            window,
            x,
            y,
            callback: () => {
              if (activeShellMenu === menu) activeShellMenu = undefined;
              setImmediate(() => resolve(null));
            },
          });
        });
      },
    );
    ipcMain.handle(
      "cod:browser-cover-modal",
      (event, cover: BrowserModalCover | undefined) => {
        if (
          event.sender !== mainWindow?.webContents ||
          event.senderFrame !== event.sender.mainFrame ||
          event.senderFrame.url !== rendererUrl ||
          cover?.kind !== "shell-modal" ||
          !Number.isSafeInteger(cover.opening)
        )
          return false;
        return operations.browserCoverModal(cover);
      },
    );
    ipcMain.handle(
      "cod:browser-prepare-modal",
      (event, ids: unknown, opening: unknown) => {
        if (
          event.sender !== mainWindow?.webContents ||
          event.senderFrame !== event.sender.mainFrame ||
          event.senderFrame.url !== rendererUrl ||
          typeof opening !== "number" ||
          !Number.isSafeInteger(opening) ||
          opening <= 0
        )
          return [];
        if (mainWindow) activeShellMenu?.closePopup(mainWindow);
        return operations.browserPrepareModal(ids, opening);
      },
    );
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
      if (remoteView)
        throw new Error("Add a folder by its Linux path from the host CLI");
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
        if (
          remoteWorkspace?.state.workspaces.some(
            (item) => item.id === workspace,
          )
        )
          throw new Error("Save As in a Linux workspace is not available yet");
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
        const result = await displayCommand(request);
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
      accelerator: menuAccelerator("settings"),
      click: () =>
        mainWindow?.webContents.send("cod:command", { command: "settings" }),
    };
    const quickTerminalItem: Electron.MenuItemConstructorOptions = {
      id: "terminal.quickToggle",
      label: "Quick Terminal",
      visible: false,
      acceleratorWorksWhenHidden: true,
      click: () => {
        const window = mainWindow;
        if (!window?.isFocused()) return;
        const contents = webContents.getFocusedWebContents();
        const browserId = contents
          ? operations.diagnosticContext(contents.id)?.browserId
          : undefined;
        if (contents && contents !== window.webContents && !browserId) return;
        if (browserId) window.webContents.focus();
        window.webContents.send("cod:command", {
          command: "terminal.quickToggle",
          browserId,
        });
      },
    };
    // Unlike the before-input route, the menu receives keys Chromium leaves
    // unhandled. Website editors and their shortcuts get the first response.
    const toggleFilesItem: Electron.MenuItemConstructorOptions = {
      label: "Toggle files",
      id: "navigation.toggleFiles",
      visible: false,
      acceleratorWorksWhenHidden: true,
      click: () => {
        const window = mainWindow;
        const contents = webContents.getFocusedWebContents();
        if (
          !window?.isFocused() ||
          !contents ||
          operations.diagnosticContext(contents.id)?.role !== "browser" ||
          !window.contentView.children.some(
            (view) =>
              view instanceof WebContentsView && view.webContents === contents,
          )
        )
          return;
        window.webContents.send("cod:command", {
          command: "navigation.toggleFiles",
        });
      },
    };
    const template: Electron.MenuItemConstructorOptions[] =
      process.platform === "darwin"
        ? [
            {
              label: app.name,
              submenu: [
                settingsItem,
                quickTerminalItem,
                toggleFilesItem,
                { type: "separator" },
                { role: "quit" },
              ],
            },
            { role: "editMenu" },
          ]
        : [
            {
              label: "File",
              submenu: [
                settingsItem,
                toggleFilesItem,
                { type: "separator" },
                { role: "quit" },
              ],
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
      settingsItem.accelerator = menuAccelerator("settings");
      toggleFilesItem.accelerator = menuAccelerator("navigation.toggleFiles");
      // AppKit can claim Command+Backquote before it reaches a view. Only an
      // explicit binding for it in Cod may take precedence over window cycling.
      quickTerminalItem.accelerator =
        keyboardPlatform === "darwin" &&
        resolveKeybinding(
          {
            key: "`",
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          keyboardPlatform,
          "shell",
        )?.command === "terminal.quickToggle"
          ? "Command+`"
          : undefined;
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    };
    refreshKeyboardMenu();
    createWindow();
    startReleaseChecks();
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
let choosingQuit = false;
let shutdown: Promise<void> | undefined;

function quitSessionLabel(name: string, limit: number): string {
  const characters = Array.from(name.replace(/\s+/g, " ").trim());
  return characters.length > limit
    ? characters.slice(0, limit - 1).join("") + "…"
    : characters.join("");
}

async function confirmQuit(): Promise<"leave" | "stop" | "cancel"> {
  const status = operations.quitStatus();
  const count = status.active.length;
  if (!count) return "stop";
  const lines = status.active
    .slice(0, 5)
    .map(
      ({ workspace, session }) =>
        `• ${quitSessionLabel(workspace, 28)} — ${quitSessionLabel(session, 42)}`,
    );
  const remaining = count - lines.length;
  if (remaining) lines.push(`… and ${remaining} more`);
  const choices = status.canLeaveRunning
    ? ["Leave Running", "Stop", "Cancel"]
    : ["Stop", "Cancel"];
  const options: Electron.MessageBoxOptions = {
    type: "question",
    title: "Quit Cod",
    message:
      count === 1
        ? "One local agent is active"
        : `${count} local agents are active`,
    detail: lines.join("\n"),
    buttons: choices,
    defaultId: choices.length - 1,
    cancelId: choices.length - 1,
    noLink: true,
  };
  const { response } = await (mainWindow
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options));
  const selected = choices[response];
  if (selected === "Leave Running")
    return operations.quitStatus().canLeaveRunning ? "leave" : confirmQuit();
  return selected === "Stop" ? "stop" : "cancel";
}

app.on("before-quit", (event) => {
  if (!initialized || quitting) return;
  event.preventDefault();
  if (choosingQuit || shutdown) return;
  choosingQuit = true;
  void confirmQuit().then(
    (decision) => {
      choosingQuit = false;
      if (decision === "cancel") return;
      commandServer?.close();
      commandServer = null;
      attachingWorkspace?.abort();
      remoteWorkspace?.close();
      remoteWorkspace = undefined;
      shutdown = operations.shutdown(decision === "leave").finally(() => {
        quitting = true;
        app.quit();
      });
      void shutdown.catch((error) => console.error(error));
    },
    (error) => {
      choosingQuit = false;
      console.error(error);
    },
  );
});
