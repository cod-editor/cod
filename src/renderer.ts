import { configureKeymap } from "./keyboard";
import { keyboardPlatform, updateKeymapStatus } from "./ui/keyboard-ui";
import { createContentFind } from "./ui/content-find";
import { applyAppearance } from "./ui/appearance";
import type { OperationName } from "./command-catalog";
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

const tree = document.querySelector<HTMLDivElement>("#workspace-tree")!;
const panes = document.querySelector<HTMLDivElement>("#panes")!;
const workspaceName =
  document.querySelector<HTMLHeadingElement>("#workspace-name")!;
const status = document.querySelector<HTMLElement>("#status")!;
const focus = createFocusManager(panes, tree, (id) => browsers.focusNative(id));
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
const documents = createDocumentViews(
  () => state,
  panes,
  invoke,
  render,
  setStatus,
);
const chats = createConversationViews({
  getState: () => state,
  invoke,
  host: panes,
  invalidate: render,
  report: setStatus,
  openReference: (workspace, reference) =>
    workspaceView.openReference(workspace, reference),
  actionButton: paneButton,
});
const layout = createPaneLayout(() => state, invoke, {
  renderPane: (workspace, pane) => workspaceView.pane(workspace, pane),
  saveFile: documents.save,
  newConversation: () => commands.newConversation(),
  browserDialog: () => commands.browser(),
  terminalDialog: () => commands.terminal(),
  openFile: () => projects.quickOpen(),
  conversationActions: (c) => commands.conversationActions(c),
  nativeLayout: browsers.layout,
});
const navigation = createWorkspaceNavigation(tree, () => state, invoke, {
  newConversation: () => commands.newConversation(),
  workspaceDialog: (mode) => commands.workspace(mode),
  folderDialog: (workspace) => commands.folder(workspace),
  conversationActions: (c) => commands.conversationActions(c),
  paneButton,
});
const projects = new FileTree(
  document.querySelector("#project-panel")!,
  invoke,
  (workspace) => commands.folder(workspace),
);

const finder = createContentFind(
  () => state,
  focus,
  terminals.find,
  browsers.layout,
);
const commands = createCommands(() => state, invoke, panes, tree, setStatus, {
  focus,
  files: projects,
  layout,
  chat: chats,
  navigation,
  saveFile: documents.save,
  focusNativeView: browsers.focusNative,
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
    chats,
    documents,
    browsers,
    terminals,
    layout,
    navigation,
    focus,
    projects,
  },
);
function render() {
  workspaceView.render();
  finder.reconcile();
}

function activeWorkspace(): WorkspaceState | undefined {
  return state.workspaces.find(
    (workspace) => workspace.id === state.activeWorkspaceId,
  );
}

function setStatus(message: string): void {
  status.textContent = message;
  const current = message;
  window.setTimeout(() => {
    if (status.textContent === current) status.textContent = "";
  }, 5000);
}

async function invoke<T>(
  op: OperationName,
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

window.cod.onState((next) => {
  const previous = state;
  state = next;
  const focusedPane = document.activeElement?.closest("[data-pane-id]");
  const comparable = structuredClone(next);
  for (const workspace of comparable.workspaces) {
    workspace.activePaneId =
      previous.workspaces.find((item) => item.id === workspace.id)
        ?.activePaneId ?? workspace.activePaneId;
  }
  if (focusedPane && JSON.stringify(comparable) === JSON.stringify(previous)) {
    const workspace = activeWorkspace();
    for (const element of panes.querySelectorAll<HTMLElement>(
      "[data-pane-id]",
    )) {
      element.dataset.active = String(
        element.dataset.paneId === workspace?.activePaneId,
      );
    }
  } else {
    render();
  }
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
void keymapReady
  .then(() => invoke<AppState>("state"))
  .then(async (next) => {
    state = next;
    if (!next.workspaces.length && !next.closedWorkspaces?.length) {
      await invoke("workspace.create", { name: "Untitled" });
      commands.focusComposer();
      return;
    }
    render();
  })
  .catch(() => undefined);

if (navigator.userAgent.includes("Mac"))
  document.body.classList.add("platform-mac");

window.addEventListener(
  "beforeunload",
  () => {
    commands.dispose();
    finder.dispose();
    layout.dispose();
    workspaceView.dispose();
    projects.dispose();
    focus.dispose();
    browsers.dispose();
    terminals.dispose();
  },
  { once: true },
);
