import { newTab } from "./ui/new-tab";
import { updateLiveActivity } from "./ui/turn-activity";
import { configureKeymap } from "./keyboard";
import { keyboardPlatform, updateKeymapStatus } from "./ui/keyboard-ui";
import { createContentFind } from "./ui/content-find";
import { applyAppearance, initializeAppearance } from "./ui/appearance";
import type { DesktopOperationName } from "./ui/contracts";
import { createWorkspaceView } from "./ui/workspace-view";
import { createCommands } from "./ui/commands";
import { createFocusManager } from "./ui/focus";
import {
  actionButton as paneButton,
  showActionError,
} from "./ui/action-feedback";
import { createPaneLayout } from "./ui/pane-layout";
import { createWorkspaceNavigation } from "./ui/workspace-navigation";
import { createBrowserViews } from "./ui/browser-views";
import { createQuickTerminal } from "./ui/quick-terminal";
import { createConversationViews } from "./ui/conversation-views";
import { createDocumentViews } from "./ui/document-views";
import { FileTree } from "./ui/files";
import { createTerminalViews } from "./ui/terminal-views";
import type { AppState, CodBridge, WorkspaceState } from "./types";

declare global {
  interface Window {
    cod: CodBridge;
  }
}

applyAppearance();

const panes = document.querySelector<HTMLDivElement>("#panes")!;
const workspaceName =
  document.querySelector<HTMLHeadingElement>("#workspace-name")!;
const status = document.querySelector<HTMLElement>("#status")!;
const focus = createFocusManager(panes, (id) => browsers.focusNative(id));
let renderedState: AppState | undefined;
const renderWaiters = new Set<() => void>();
let state: AppState = {
  workspaces: [],
  activeWorkspaceId: null,
  conversations: [],
  terminals: [],
  browsers: [],
  drafts: {},
};
const browsers = createBrowserViews(panes, () => state, invoke, paneButton);
const terminals = createTerminalViews(() => state, invoke);
const quickTerminal = createQuickTerminal(
  () => state,
  invoke,
  terminals,
  focus,
  browsers.stageBrowserBackdrop,
);
document.querySelector("#pane-visibility")!.append(quickTerminal.trigger);
const documents = createDocumentViews(
  () => state,
  panes,
  invoke,
  render,
  setStatus,
  (key, modified) => layout.documentModified(key, modified),
);
const chats = createConversationViews({
  getState: () => state,
  invoke,
  host: panes,
  invalidate: render,
  report: setStatus,
  openReference: (workspace, reference, conversation, kind) =>
    workspaceView.openReference(workspace, reference, conversation, kind),
  actionButton: paneButton,
});
const layout = createPaneLayout(() => state, invoke, {
  whenRendered,
  newTab: (workspace, group) => commands.newTab(workspace, group),
  chooseTabType: (anchor, workspace, group) =>
    commands.chooseTabType(anchor, workspace, group),
  renderPane: (workspace, pane) => workspaceView.pane(workspace, pane),
  saveFile: documents.save,
  documentModified: documents.modified,
  conversationActions: (c) => commands.conversationActions(c),
  nativeLayout: browsers.layout,
});
const downloadPreview = paneButton("Download update", async () => {
  try {
    await window.cod.openPreviewUpdate();
  } catch {
    setStatus("Could not open the preview download");
  }
});
downloadPreview.textContent = "Download";
downloadPreview.setAttribute("aria-label", "Download update");
downloadPreview.classList.add("preview-update");
downloadPreview.hidden = true;
document.querySelector("#pane-visibility")!.prepend(downloadPreview);
window.cod.onPreviewUpdate((version) => {
  downloadPreview.hidden = !version;
  downloadPreview.title = version ? `Download Cod ${version}` : "";
});
const navigation = createWorkspaceNavigation(() => state, invoke, {
  folderDialog: (workspace, restoreFocus) =>
    commands.folder(workspace, restoreFocus),
  conversationActions: (c, rename) => commands.conversationActions(c, rename),
});
const projects = new FileTree(
  document.querySelector("#project-panel")!,
  invoke,
  (workspace) => commands.folder(workspace),
  focus,
);

const finder = createContentFind(
  () => state,
  focus,
  terminals.find,
  browsers.layout,
);
const commands = createCommands(() => state, invoke, panes, setStatus, {
  focus,
  whenRendered,
  files: projects,
  layout,
  chat: chats,
  navigation,
  saveFile: documents.save,
  focusNativeView: browsers.focusNative,
  showBrowserZoom: browsers.showZoom,
  quickTerminal,
  stageBrowserBackdrop: browsers.stageBrowserBackdrop,
  find: finder,
});

const workspaceView = createWorkspaceView(
  panes,
  workspaceName,
  () => state,
  invoke,
  setStatus,
  () => commands.workspace("create"),
  {
    newTab: (workspace, pane) =>
      newTab({
        file: () => commands.newFileInBlankTab(workspace, pane.id),
        browser: () =>
          commands.browser({ workspace: workspace.id, pane: pane.id }),
        chat: () => commands.newConversation(workspace.id, pane.id),
        terminal: () =>
          commands.terminal({ workspace: workspace.id, pane: pane.id }),
      }),
    chatOpen: commands.chatOpen,
    chats,
    documents,
    browsers,
    terminals,
    layout,
    focus,
    projects,
  },
);
function render() {
  workspaceView.render();
  finder.reconcile();
  renderedState = state;
  for (const complete of [...renderWaiters]) complete();
}
function whenRendered(
  check: () => boolean | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      renderWaiters.delete(complete);
      signal.removeEventListener("abort", cancelled);
      resolve(ready);
    };
    const cancelled = () => finish(false);
    const complete = () => {
      if (signal.aborted) return finish(false);
      if (renderedState !== state) return;
      const decision = check();
      if (decision !== undefined) finish(decision);
    };
    renderWaiters.add(complete);
    signal.addEventListener("abort", cancelled, { once: true });
    complete();
  });
}

function activeWorkspace(): WorkspaceState | undefined {
  return state.workspaces.find(
    (workspace) => workspace.id === state.activeWorkspaceId,
  );
}

function setStatus(message: string): void {
  status.textContent = message;
  status.title = message;
  const current = message;
  window.setTimeout(() => {
    if (status.textContent === current) {
      status.textContent = "";
      status.title = "";
    }
  }, 5000);
}

async function invoke<T>(
  op: DesktopOperationName,
  values: Record<string, unknown> = {},
  options: { reportError?: boolean } = {},
): Promise<T> {
  const surface =
    document.activeElement?.closest("dialog, [data-pane-id]") ?? null;
  try {
    return await window.cod.invoke<T>({ op, ...values });
  } catch (cause) {
    const error = new Error(
      (cause instanceof Error ? cause.message : String(cause)).replace(
        /^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/,
        "",
      ),
    );
    if (options.reportError !== false) {
      if (surface?.isConnected) showActionError(error, surface);
      else setStatus(error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

window.cod.onCommand(({ command, browserId }) => {
  void commands.execute(command, browserId);
});

let pendingStateRender = false;
window.cod.onState((next) => {
  state = next;
  quickTerminal.reconcile();
  commands.refresh();
  if (pendingStateRender) return;
  pendingStateRender = true;
  requestAnimationFrame(() => {
    pendingStateRender = false;
    render();
  });
});
const keymapReady = window.cod.getKeymap().then((keymap) => {
  configureKeymap(keymap.overrides, keyboardPlatform);
  updateKeymapStatus(keymap);
});
window.cod.onKeymap((keymap) => {
  configureKeymap(keymap.overrides, keyboardPlatform);
  updateKeymapStatus(keymap);
  render();
});
void Promise.all([keymapReady, initializeAppearance()])
  .then(() => invoke<AppState>("state"))
  .then((next) => {
    state = next;
    quickTerminal.reconcile();
    render();
    if (
      document.activeElement === document.body &&
      !document.querySelector("dialog[open]")
    )
      panes
        .querySelector<HTMLTextAreaElement>(
          '[data-active="true"] textarea[aria-label="Message"]',
        )
        ?.focus();
    document.body.dataset.ready = "true";
  })
  .catch(() => undefined);

if (navigator.userAgent.includes("Mac"))
  document.body.classList.add("platform-mac");

const activityClock = setInterval(() => updateLiveActivity(), 1000);

window.addEventListener(
  "beforeunload",
  () => {
    clearInterval(activityClock);
    commands.dispose();
    finder.dispose();
    layout.dispose();
    workspaceView.dispose();
    projects.dispose();
    focus.dispose();
    browsers.dispose();
    terminals.dispose();
    documents.dispose();
  },
  { once: true },
);
