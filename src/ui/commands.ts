import {
  uiButton,
  actionRow,
  dialogSurface,
  describeButton,
} from "./primitives";
import { createWorkspaceOverview } from "./workspace-overview";
import type { createWorkspaceNavigation } from "./workspace-navigation";
import { focusedWebLink, webLink, webLinkMenu } from "./web-links";
import { browserBookmarks } from "./browser-bookmarks";
import { browserDownloads } from "./browser-downloads";
import { sitePermissions } from "./browser-permissions";
import { browserHistory } from "./browser-library";
import { showProviderCommands } from "./provider-commands";
import {
  conversationRemovalReason,
  conversationHandoffReason,
} from "../conversation-actions";
import { createFocusTargets } from "./focus-targets";
import {
  commands as commandDefinitions,
  resolveKeybinding,
  formatShortcut,
  type CommandId,
} from "../keyboard";
import {
  keyboardPlatform,
  keyboardSurface,
  showKeyboardShortcuts,
  shortcutTitle,
} from "./keyboard-ui";
import { createKeyboardNavigation } from "./keyboard-navigation";
import { paneRegions } from "./pane-layout";
import { createSearchList } from "./search-list";
import { appearanceDialog, changeTextSize } from "./appearance";
import { inputDialog, confirmAction } from "./dialogs";
import { actionButton as paneButton, showActionError } from "./action-feedback";
import { menu, type MenuAction } from "./controls";
import type {
  AppState,
  PaneState,
  WorkspaceState,
  ConversationState,
} from "../types";
import type { Invoke, WhenRendered } from "./contracts";
import type { createFocusManager } from "./focus";
type ConversationAction = Exclude<MenuAction, null> & { command?: CommandId };
interface CommandContext {
  linkUrl?: string;
  devtoolsBrowserId?: string;
  workspaceId?: string;
  paneId?: string;
  conversationId?: string;
}
interface CommandFeatures {
  whenRendered: WhenRendered;
  focus: ReturnType<typeof createFocusManager>;
  files: {
    quickOpen: (target?: {
      workspace: WorkspaceState;
      sourcePane?: string;
      group?: string;
      restoreFocus?: () => void;
    }) => void;
    search: () => void;
  };
  layout: {
    toggle: (key: "filesVisible" | "workspacesVisible") => void;
    split: (direction: "right" | "down") => void;
    zoom: () => void;
    togglePane: (side: "left" | "right", signal?: AbortSignal) => Promise<void>;
    sidePane: (side: "left" | "right") => Promise<string | undefined>;
    paneToggleReason: (side: "left" | "right") => string | undefined;
  };
  chat: { send: (id: string) => Promise<void>; integration: () => void };
  navigation: ReturnType<typeof createWorkspaceNavigation>;
  saveFile: (workspace: string, pane: string) => Promise<void>;
  focusNativeView: (id: string) => void;
  find: { open: (pane: import("../types").PaneState) => void };
}
export function createCommands(
  getState: () => AppState,
  invoke: Invoke,
  panes: HTMLElement,
  tree: HTMLElement,
  setStatus: (message: string) => void,
  features: CommandFeatures,
) {
  const { focus, files: projects, layout, chat: chats, navigation } = features;
  const localInvoke: Invoke = (op, values) =>
    invoke(op, values, { reportError: false });
  const keys = createKeyboardNavigation(
    getState,
    invoke,
    panes,
    tree,
    focus.native,
    features.focusNativeView,
    features.whenRendered,
  );
  const focusTargets = createFocusTargets(getState, invoke, focus, keys);
  const overview = createWorkspaceOverview(
    getState,
    invoke,
    navigation,
    focus,
    async (item) => {
      const intent = keys.beginFocus();
      await navigation.open(item, intent.signal);
      if (intent.signal.aborted) return;
      const ready = await features.whenRendered(
        () =>
          getState().activeWorkspaceId === item.workspaceId ? true : undefined,
        intent.signal,
      );
      if (!ready) return;
      const workspace = getState().workspaces.find(
        (w) => w.id === item.workspaceId,
      );
      const pane =
        navigation.items().find((row) => row.key === item.key)?.paneId ??
        workspace?.activePaneId;
      if (pane) await keys.focusPane(pane, intent);
    },
    {
      fallback: async () => {
        const intent = keys.beginFocus();
        const pane = activeWorkspace()?.panes.find(
          (p) => p.id === activeWorkspace()?.activePaneId,
        );
        if (
          pane &&
          (await features.whenRendered(
            () =>
              document.querySelector(`[data-pane-id="${pane.id}"]`)
                ? true
                : undefined,
            intent.signal,
          ))
        ) {
          if (
            intent.signal.aborted ||
            activeWorkspace()?.activePaneId !== pane.id ||
            document.querySelector("dialog[open]")
          )
            return;
          await keys.content(pane, intent);
        }
      },
      newConversation: async (workspace) => {
        const intent = keys.beginFocus();
        const result = await invoke<{ paneId: string }>("conversation.draft", {
          workspace,
        });
        if (
          await features.whenRendered(
            () =>
              getState().activeWorkspaceId === workspace &&
              activeWorkspace()?.activePaneId === result.paneId
                ? true
                : undefined,
            intent.signal,
          )
        )
          await keys.focusActiveContent(result.paneId, intent);
      },
      openPane: async (workspace, pane) => {
        const intent = keys.beginFocus();
        await invoke("pane.focus", { workspace, id: pane });
        if (
          await features.whenRendered(
            () =>
              getState().activeWorkspaceId === workspace &&
              activeWorkspace()?.activePaneId === pane
                ? true
                : undefined,
            intent.signal,
          )
        )
          await keys.focusActiveContent(pane, intent);
      },
    },
  );

  const events = new AbortController();
  document.addEventListener(
    "contextmenu",
    (event) => {
      const editor = (event.target as Element).closest<HTMLTextAreaElement>(
        "textarea.file-editor",
      );
      if (!editor) return;
      const url = focusedWebLink(editor);
      const paneId =
        editor.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
      const owner = getState().workspaces.find((w) =>
        w.panes.some((p) => p.id === paneId),
      );
      if (
        url &&
        owner &&
        webLinkMenu(
          { x: event.clientX, y: event.clientY },
          url,
          owner.id,
          invoke,
        )
      )
        event.preventDefault();
    },
    { signal: events.signal },
  );
  let refreshPalette: (() => void) | undefined;
  const listen = (
    type: "keydown",
    callback: (event: KeyboardEvent) => void,
    capture = false,
  ) =>
    document.addEventListener(type, callback, {
      capture,
      signal: events.signal,
    });
  const activeWorkspace = () =>
    getState().workspaces.find((w) => w.id === getState().activeWorkspaceId);
  function moveConversation(conversation: ConversationState): void {
    const dialog = document.createElement("dialog");
    dialog.className = "picker search-picker";
    dialog.setAttribute("aria-label", "Move conversation to workspace");
    const input = document.createElement("input");
    input.placeholder = "Move to workspace...";
    input.setAttribute("aria-label", "Destination workspace");
    const list = document.createElement("div");
    list.className = "command-list";
    dialog.append(input, list);
    for (const workspace of getState().workspaces.filter(
      (w) => w.id !== conversation.workspaceId,
    )) {
      const button = paneButton(workspace.name, async () => {
        await localInvoke("conversation.move", {
          id: conversation.id,
          workspace: workspace.id,
          follow: true,
        });
        dialog.close();
      });
      list.append(button);
    }
    const selection = createSearchList(input, list);
    selection.update();
    input.oninput = () => {
      for (const button of list.querySelectorAll<HTMLButtonElement>("button"))
        button.hidden = !button.textContent
          ?.toLowerCase()
          .includes(input.value.toLowerCase());
      selection.update();
    };
    dialog.onclose = () => dialog.remove();
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  }
  function conversationActions(
    conversation: ConversationState,
    renameOverride?: () => void,
  ): Array<ConversationAction | null> {
    const rename: ConversationAction = {
      command: "conversation.rename",
      label: "Rename",
      run: () => {
        if (renameOverride) renameOverride();
        else void navigation.renameConversation(conversation.id);
      },
    };
    const removalReason = conversationRemovalReason(getState(), conversation);
    const remove: ConversationAction = {
      command: "conversation.remove",
      label: "Remove from workspace",
      disabled: !!removalReason,
      title:
        removalReason ??
        "Keep the native session history. Undo with Reopen closed tab.",
      run: () => {
        void invoke("conversation.remove", { id: conversation.id })
          .then(() => {
            requestAnimationFrame(() => {
              if (tree.getClientRects().length)
                focus.restore({ workspaceId: conversation.workspaceId });
            });
          })
          .catch(() => undefined);
      },
    };
    if (conversation.handoffTerminalId) {
      const terminal = getState().terminals.find(
        (t) => t.id === conversation.handoffTerminalId,
      );
      return [
        rename,
        {
          label: "Open CLI terminal",
          command: "conversation.openCli",
          disabled: !terminal,
          run: () => {
            if (terminal)
              void invoke("pane.focus", {
                workspace: conversation.workspaceId,
                id: terminal.paneId,
              });
          },
        },
        {
          label: "Return to chat",
          command: "conversation.reclaim",
          disabled:
            !!terminal && ["running", "starting"].includes(terminal.status),
          run: () =>
            void invoke("conversation.reclaim", { id: conversation.id }),
        },
        null,
        remove,
      ];
    }
    const handoffReason = conversationHandoffReason(getState(), conversation);
    return [
      rename,
      {
        label: "Session info...",
        command: "conversation.info",
        run: () =>
          showProviderCommands({ id: conversation.id, invoke }, "status"),
      },
      {
        label: "Move to workspace...",
        command: "conversation.move",
        disabled: getState().workspaces.length < 2,
        title:
          getState().workspaces.length < 2
            ? "Create another workspace first"
            : undefined,
        run: () => moveConversation(conversation),
      },
      {
        label: "Continue in CLI",
        command: "conversation.handoff",
        disabled: !!handoffReason,
        title: handoffReason,
        run: () => void invoke("conversation.handoff", { id: conversation.id }),
      },
      null,
      remove,
    ];
  }
  function defaultBrowserDialog(): void {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "Default browser");
    const heading = document.createElement("h2");
    heading.textContent = "Default browser";
    const status = document.createElement("p");
    status.textContent = "Checking system registration...";
    const close = paneButton("Close", async () => dialog.close());
    dialog.append(heading, status, close);
    document.body.append(dialog);
    dialog.onclose = () => dialog.remove();
    dialog.showModal();
    void invoke<{
      available: boolean;
      http: boolean;
      https: boolean;
      reason?: string;
    }>("browser.default-status")
      .then((result) => {
        status.textContent = result.available
          ? result.http && result.https
            ? "Cod is the default browser."
            : "Cod can open web links from other applications."
          : result.reason ||
            "Install the packaged application to register Cod as a browser.";
        if (result.available && !(result.http && result.https)) {
          const register = paneButton("Make default browser", async () => {
            const result = await invoke<{
              current: { http: boolean; https: boolean };
            }>("browser.register-default");
            status.textContent =
              result.current.http && result.current.https
                ? "Cod is the default browser."
                : "The request was sent. Complete the change in system settings.";
          });
          dialog.append(register);
        }
      })
      .catch((error) => (status.textContent = String(error)));
  }

  function focusActiveComposer(): void {
    requestAnimationFrame(() =>
      panes
        .querySelector<HTMLTextAreaElement>(
          '[data-active="true"] textarea[aria-label="Message"]',
        )
        ?.focus(),
    );
  }
  async function newConversation(
    workspace?: string,
    replacePane?: string,
  ): Promise<unknown> {
    const result = await invoke<{ workspaceId: string; paneId: string }>(
      "conversation.draft",
      {
        ...(workspace ? { workspace } : {}),
        ...(replacePane ? { replacePane } : {}),
      },
    );
    requestAnimationFrame(() => {
      const active = activeWorkspace();
      if (
        active?.id === result.workspaceId &&
        active.activePaneId === result.paneId
      )
        panes
          .querySelector<HTMLTextAreaElement>(
            `[data-pane-id="${result.paneId}"] textarea[aria-label="Message"]`,
          )
          ?.focus();
    });
    return result;
  }

  function tabTarget(workspaceId?: string, groupId?: string) {
    const workspace = workspaceId
      ? getState().workspaces.find((w) => w.id === workspaceId)
      : activeWorkspace();
    const group = workspace?.groups?.find(
      (g) => g.id === (groupId ?? workspace.activeGroupId),
    );
    if (!workspace || !group) throw new Error("Select a pane first");
    return { workspace, group, sourcePane: group.activePaneId };
  }
  async function createTab(
    op:
      | "pane.new"
      | "browser.open"
      | "conversation.draft"
      | "terminal.open"
      | "file.new",
    values: { workspace: string; [key: string]: unknown },
    intent = keys.beginFocus(),
  ): Promise<void> {
    const result = await invoke<{ paneId: string }>(op, {
      ...values,
      focus: false,
    });
    if (intent.signal.aborted) return;
    await invoke("pane.focus", {
      workspace: values.workspace,
      id: result.paneId,
    });
    await keys.focusActiveContent(result.paneId, intent);
  }
  async function newTab(workspaceId?: string, groupId?: string): Promise<void> {
    const { workspace, group, sourcePane } = tabTarget(workspaceId, groupId);
    await createTab("pane.new", {
      workspace: workspace.id,
      group: group.id,
      sameAs: sourcePane,
    });
  }
  function chooseTabType(
    anchor: HTMLElement,
    workspaceId?: string,
    groupId?: string,
  ): void {
    const { workspace, group, sourcePane } = tabTarget(workspaceId, groupId);
    const create = async (
      op: "browser.open" | "conversation.draft" | "terminal.open",
    ) => {
      await createTab(op, {
        workspace: workspace.id,
        group: group.id,
        sourcePane,
        ...(op === "browser.open" ? { url: "about:blank" } : {}),
      });
    };
    const run = (op: "browser.open" | "conversation.draft" | "terminal.open") =>
      void create(op).catch(() => undefined);
    menu(anchor, [
      {
        label: "Open file",
        run: () =>
          projects.quickOpen({
            workspace,
            sourcePane,
            group: group.id,
            restoreFocus: () => {
              if (anchor.isConnected) anchor.focus({ preventScroll: true });
            },
          }),
      },
      { label: "Browser", run: () => run("browser.open") },
      { label: "Chat", run: () => run("conversation.draft") },
      { label: "Terminal", run: () => run("terminal.open") },
    ]);
  }

  function reopenTab(intent = keys.beginFocus()): void {
    const w = activeWorkspace();
    if (!w) return;
    const closed = w.closedTabs?.at(-1);
    const reopen = async (newShell = false, focusIntent = intent) => {
      const result = await invoke<{ paneId: string }>("pane.reopen", {
        workspace: w.id,
        ...(newShell ? { newShell: true } : {}),
      });
      await keys.focusActiveContent(result.paneId, focusIntent);
    };
    if (closed?.terminal)
      confirmAction(
        "Start a new shell?",
        `Start a new shell in ${closed.terminal.cwd}? The previous process has ended; commands will not be replayed.`,
        "Start shell",
        () => reopen(true, keys.beginFocus()),
      );
    else void reopen();
  }
  function reopenWorkspace(): void {
    const closed = getState().closedWorkspaces?.at(-1);
    if (!closed) {
      setStatus("No closed workspace");
      return;
    }
    if (closed.terminals.length)
      confirmAction(
        "Reopen workspace?",
        `Reopen ${closed.workspace.name} with new shells? Previous terminal processes have ended; commands will not be replayed.`,
        "Reopen workspace",
        () =>
          invoke("workspace.reopen", {
            id: closed.workspace.id,
            newShell: true,
          }),
      );
    else void invoke("workspace.reopen", { id: closed.workspace.id });
  }
  function sendActiveMessage(pane: PaneState | undefined): void {
    if (pane?.kind === "conversation") void chats.send(pane.conversationId);
    else
      panes
        .querySelector<HTMLTextAreaElement>(
          '[data-pane-id="' + pane?.id + '"] textarea[aria-label="Message"]',
        )
        ?.dispatchEvent(new Event("cod:send-message"));
  }
  function chatWidthDialog(): void {
    const workspace = activeWorkspace();
    if (!workspace) return;
    inputDialog({
      title: "Chat maximum width",
      label: "Chat maximum width (pixels)",
      type: "number",
      min: 480,
      max: 4000,
      value: String(workspace.settings?.chatMaxWidth ?? 1100),
      submitLabel: "Save",
      submit: (value) =>
        localInvoke("workspace.settings", {
          id: workspace.id,
          settings: { chatMaxWidth: Number(value) },
        }),
    });
  }

  function browserDialog(target?: { workspace: string; pane: string }): void {
    const workspace = target
      ? getState().workspaces.find((item) => item.id === target.workspace)
      : activeWorkspace();
    if (!workspace) return;
    void invoke<{ paneId: string }>("browser.open", {
      workspace: workspace.id,
      url: "about:blank",
      ...(target ? { replacePane: target.pane } : {}),
    })
      .then((browser) => {
        requestAnimationFrame(() => {
          const address = panes.querySelector<HTMLInputElement>(
            `[data-pane-id="${browser.paneId}"] input[aria-label="Address"]`,
          );
          address?.focus();
          address?.select();
        });
      })
      .catch(() => {});
  }

  function resumeConversationDialog(): void {
    const workspace = activeWorkspace();
    if (!workspace) return;
    const returnFocus = focus.capture();
    const dialog = dialogSurface("Open existing session");
    dialog.className = "session-picker";
    const heading = document.createElement("h2");
    heading.textContent = "Open existing session";
    const form = document.createElement("form");
    const provider = document.createElement("select");
    provider.setAttribute("aria-label", "Provider");
    provider.append(new Option("Codex", "codex"), new Option("Kimi", "kimi"));
    const cwd = document.createElement("input");
    cwd.setAttribute("aria-label", "Working directory");
    cwd.placeholder = "Working directory";
    cwd.value = workspace.folders[0] ?? "";
    const search = uiButton("Find sessions");
    search.type = "submit";
    form.append(provider, cwd, search);
    const filter = document.createElement("input");
    filter.setAttribute("aria-label", "Filter sessions");
    filter.placeholder = "Search sessions...";
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    const list = document.createElement("div");
    list.className = "command-list";
    const selection = createSearchList(filter, list);
    const manual = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Open by session ID";
    const nativeId = document.createElement("input");
    nativeId.setAttribute("aria-label", "Native session ID");
    nativeId.placeholder = "Native session ID";
    let generation = 0;
    let loading = false;
    let discoveryError = "";
    let opening = false;
    let performed = false;
    const resume = async (
      id: string,
      directory?: string,
      selectedProvider = provider.value,
    ) => {
      if (opening || !dialog.isConnected || !dialog.open) return;
      opening = true;
      const intent = keys.beginFocus();
      status.textContent = "Opening session...";
      try {
        const result = await localInvoke<{ id: string; paneId: string }>(
          "conversation.resume",
          {
            workspace: workspace.id,
            provider: selectedProvider,
            nativeId: id,
            ...(directory
              ? { cwd: directory }
              : cwd.value
                ? { cwd: cwd.value }
                : {}),
          },
        );
        if (!dialog.isConnected || !dialog.open) return;
        performed = true;
        dialog.close();
        // Native close can reset the old caret. Preserve it without focusing
        // that pane again after the requested conversation was selected.
        const invoker = returnFocus.element;
        if (
          (invoker instanceof HTMLTextAreaElement ||
            invoker instanceof HTMLInputElement) &&
          returnFocus.selectionStart !== undefined &&
          returnFocus.selectionEnd !== undefined
        ) {
          invoker.setSelectionRange(
            returnFocus.selectionStart,
            returnFocus.selectionEnd,
          );
          invoker.scrollTop = returnFocus.scrollTop ?? 0;
          invoker.scrollLeft = returnFocus.scrollLeft ?? 0;
        }
        const rendered = await features.whenRendered(() => {
          const state = getState();
          const conversation = state.conversations.find(
            (item) => item.id === result.id,
          );
          if (!conversation) return undefined;
          return state.activeWorkspaceId === conversation.workspaceId
            ? true
            : undefined;
        }, intent.signal);
        if (rendered) await keys.focusActiveContent(result.paneId, intent);
      } catch (error) {
        if (dialog.isConnected && dialog.open)
          status.textContent = String(error);
      } finally {
        opening = false;
      }
    };
    const open = paneButton("Open session", async () => {
      if (nativeId.value.trim()) await resume(nativeId.value.trim());
    });
    nativeId.onkeydown = (event) => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        event.getModifierState("AltGraph")
      )
        return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (!event.repeat) open.click();
      }
    };
    manual.append(summary, nativeId, open);
    const cancelPicker = () => {
      dialog.close();
      // Native dialog restoration focuses the invoker but resets its selection.
      // Restore at cancellation, before a later close event can race new focus.
      focus.restore(returnFocus);
    };
    const cancel = paneButton("Cancel", async () => cancelPicker());
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancelPicker();
    });
    dialog.append(
      heading,
      form,
      filter,
      status,
      list,
      manual,
      actionRow(cancel),
    );
    document.body.append(dialog);
    dialog.onclose = () => {
      ++generation;
      const restore =
        dialog.contains(document.activeElement) ||
        document.activeElement === document.body;
      dialog.remove();
      if (!performed && restore) focus.restore(returnFocus);
    };
    const filterRows = () => {
      const terms = filter.value
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      let matches = 0;
      const rows = list.querySelectorAll<HTMLButtonElement>("button");
      for (const button of rows) {
        button.hidden = !terms.every((term) =>
          button.dataset.search?.includes(term),
        );
        if (!button.hidden) ++matches;
      }
      selection.update();
      status.textContent =
        discoveryError ||
        (loading
          ? "Finding sessions..."
          : matches
            ? ""
            : rows.length
              ? "No matching sessions."
              : "No sessions found in this directory.");
      status.setAttribute("role", discoveryError ? "alert" : "status");
    };
    filter.oninput = filterRows;
    provider.onchange = () => form.requestSubmit();
    form.onsubmit = (event) => {
      event.preventDefault();
      const current = ++generation;
      const selectedProvider = provider.value;
      loading = true;
      discoveryError = "";
      list.replaceChildren();
      search.disabled = true;
      filterRows();
      void localInvoke<import("../providers/types").Conversation[]>(
        "conversation.discover",
        {
          workspace: workspace.id,
          provider: selectedProvider,
          ...(cwd.value ? { cwd: cwd.value } : {}),
        },
      )
        .then((sessions) => {
          if (current !== generation || !dialog.isConnected || !dialog.open)
            return;
          loading = false;
          const rows = document.createDocumentFragment();
          for (const session of sessions) {
            const metadata = session.metadata as Record<string, unknown> | null;
            const label =
              [metadata?.name, metadata?.title, metadata?.preview].find(
                (value): value is string =>
                  typeof value === "string" && !!value.trim(),
              ) ?? session.nativeId;
            const button = describeButton(
              paneButton(label.slice(0, 500), () =>
                resume(session.nativeId, session.cwd, session.provider),
              ),
              typeof metadata?.preview === "string" &&
                metadata.preview !== label
                ? metadata.preview.slice(0, 200)
                : session.cwd,
            );
            button.title = `${label.slice(0, 2000)}\n${session.nativeId}\n${session.cwd}`;
            button.setAttribute(
              "aria-description",
              `${session.nativeId}\n${session.cwd}`,
            );
            button.dataset.search = [
              label,
              metadata?.preview,
              session.nativeId,
              session.cwd,
            ]
              .filter((value) => typeof value === "string")
              .join("\n")
              .toLowerCase();
            rows.append(button);
          }
          list.replaceChildren(rows);
          filterRows();
        })
        .catch((error) => {
          if (current !== generation || !dialog.isConnected || !dialog.open)
            return;
          loading = false;
          discoveryError = String(error);
          filterRows();
        })
        .finally(() => {
          if (current === generation && dialog.isConnected && dialog.open)
            search.disabled = false;
        });
    };
    dialog.showModal();
    filter.focus();
    form.requestSubmit();
  }

  function terminalDialog(target?: { workspace: string; pane: string }): void {
    const workspace = target
      ? getState().workspaces.find((item) => item.id === target.workspace)
      : activeWorkspace();
    if (!workspace) return;
    void invoke<{ paneId: string }>("terminal.open", {
      workspace: workspace.id,
      ...(target ? { replacePane: target.pane } : {}),
    })
      .then((terminal) =>
        requestAnimationFrame(() =>
          panes
            .querySelector<HTMLTextAreaElement>(
              `[data-pane-id="${terminal.paneId}"] .xterm-helper-textarea`,
            )
            ?.focus(),
        ),
      )
      .catch(() => {});
  }

  let choosingFolder = false;
  function folderDialog(
    workspaceId = activeWorkspace()?.id,
    restoreFocus?: () => void,
  ): void {
    if (!workspaceId || choosingFolder) return;
    choosingFolder = true;
    const returnFocus = focus.capture();
    const surface =
      document.activeElement?.closest("dialog") ??
      panes.querySelector("[data-pane-id]") ??
      panes;
    void window.cod
      .chooseDirectory()
      .then(async (path) => {
        if (path !== null)
          await localInvoke("workspace.add-folder", { id: workspaceId, path });
      })
      .catch((error) => showActionError(error, surface))
      .finally(() => {
        choosingFolder = false;
        if (restoreFocus) restoreFocus();
        else focus.restore(returnFocus);
      });
  }
  function workspaceDialog(mode: "create" | "rename"): void {
    if (mode === "create") {
      void invoke("workspace.create", { name: "Untitled" })
        .then(() => focusActiveComposer())
        .catch(() => {});
      return;
    }
    const workspace = activeWorkspace();
    if (!workspace) return;
    void navigation.renameWorkspace(workspace.id);
  }

  const currentPane = () => {
    const w = activeWorkspace();
    return w?.panes.find((p) => p.id === w.activePaneId);
  };
  function focusedTreeId(): string | undefined {
    return document.activeElement?.closest<HTMLElement>(
      '[role="treeitem"][data-workspace-id]',
    )?.dataset.workspaceId;
  }
  function conversationTarget(pane = currentPane()) {
    const treeId = focusedTreeId();
    const id =
      treeId ??
      (pane?.kind === "conversation" ? pane.conversationId : undefined);
    return getState().conversations.find(
      (conversation) => conversation.id === id,
    );
  }
  function workspaceTarget(fallback = activeWorkspace()) {
    const id = focusedTreeId();
    const owner =
      getState().conversations.find((item) => item.id === id)?.workspaceId ??
      getState().reviews?.find((item) => item.id === id)?.workspaceId ??
      getState().browsers.find((item) => item.id === id)?.workspaceId ??
      id;
    return getState().workspaces.find((item) => item.id === owner) ?? fallback;
  }
  function conversationCommand(
    id: CommandId,
    target: ConversationState | null | undefined,
  ) {
    return target
      ? conversationActions(target).find((action) => action?.command === id)
      : undefined;
  }
  function disabledReason(
    id: CommandId,
    w: WorkspaceState | null | undefined = activeWorkspace(),
    pane: PaneState | null | undefined = currentPane(),
    conversation: ConversationState | null = conversationTarget(
      pane ?? undefined,
    ) ?? null,
    linkUrl = focusedWebLink(document.activeElement),
  ): string | undefined {
    if (id === "link.open")
      return linkUrl && w ? undefined : "Place the caret on a web link first";
    if (id === "browser.openExternal") {
      const current =
        pane?.kind === "browser"
          ? getState().browsers.find((item) => item.id === pane.browserId)
          : undefined;
      return linkUrl || webLink(current?.url ?? "")
        ? undefined
        : "Select a web link or browser page first";
    }
    const group = w?.groups?.find((g) =>
      g.paneIds.includes(pane?.id ?? w.activePaneId),
    );
    if (
      [
        "palette",
        "devtools.toggle",
        "shortcuts",
        "shortcuts.openFile",
        "settings",
        "workspace.new",
        "workspace.overview",
        "chat.new",
        "integration.install",
        "browser.default",
        "browser.settings",
        "browser.downloads",
        "browser.permissions",
        "workspace.reopen",
        "text.inc",
        "text.dec",
        "text.reset",
      ].includes(id)
    )
      return;
    if (id.startsWith("conversation.")) {
      if (!conversation) return "Select a conversation first";
      const action = conversationCommand(id, conversation);
      if (!action) return "This action is unavailable for this session";
      return action.disabled
        ? (action.title ??
            "This action is unavailable while the native CLI is running")
        : undefined;
    }
    if (!w) return "Open a workspace first";
    if (id === "pane.toggleRight") return layout.paneToggleReason("right");
    if (id === "pane.toggleLeft") return layout.paneToggleReason("left");
    if (
      ["chat.send", "chat.stop"].includes(id) &&
      !(
        pane?.kind === "conversation" ||
        (pane?.kind === "document" && !pane.filePath)
      )
    )
      return "Select a chat first";
    if (
      id === "chat.stop" &&
      !getState().conversations.some(
        (c) =>
          c.paneId === pane?.id && ["working", "waiting"].includes(c.status),
      )
    )
      return "No response is running";
    if (
      (id === "files.save" &&
        !(
          pane?.kind === "untitled" ||
          (pane?.kind === "document" && pane.filePath)
        )) ||
      (id === "review.document" &&
        !(pane?.kind === "document" && pane.filePath))
    )
      return "Select an editable file first";
    if (id === "files.preview") {
      const target =
        pane?.kind === "review"
          ? getState().reviews?.find((r) => r.id === pane.reviewId)?.target
          : undefined;
      const path =
        pane?.kind === "document" || pane?.kind === "preview"
          ? pane.filePath
          : target?.kind === "document"
            ? target.path
            : undefined;
      if (!path || !/\.md(?:own|arkdown)?$/i.test(path))
        return "Select a Markdown document first";
    }
    if (
      ["browser.address", "browser.bookmark", "browser.pin"].includes(id) &&
      pane?.kind !== "browser"
    )
      return "Select a browser tab first";
    const paneNumber = /^pane\.focus([1-9])$/.exec(id);
    if (paneNumber && Number(paneNumber[1]) > (w.groups?.length ?? 0))
      return "That pane is not open";
    const tabNumber = /^tab\.focus([1-8])$/.exec(id);
    if (tabNumber && Number(tabNumber[1]) > (group?.paneIds.length ?? 0))
      return "That tab is not open";
    if (id === "tab.moveToPane" && (w.groups?.length ?? 0) < 2)
      return "Open a second pane first";
    if (
      id === "tab.reorderLeft" &&
      (!group || group.paneIds.indexOf(pane?.id ?? w.activePaneId) <= 0)
    )
      return "Already the first tab";
    if (
      id === "tab.reorderRight" &&
      (!group ||
        group.paneIds.indexOf(pane?.id ?? w.activePaneId) >=
          group.paneIds.length - 1)
    )
      return "Already the last tab";
    if (
      ["review.addComment", "review.submit"].includes(id) &&
      pane?.kind !== "review"
    )
      return "Select a review first";
  }
  async function execute(
    id: CommandId,
    browserId?: string,
    context?: CommandContext,
  ): Promise<void> {
    const focusIntent = keys.beginFocus();
    if (browserId) focus.native(browserId);
    if (id === "workspace.overview") {
      overview.toggle();
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    const browser = browserId
      ? getState().browsers.find((b) => b.id === browserId)
      : undefined;
    if (browserId && !browser) return;
    const focusedPaneId =
      document.activeElement?.closest<HTMLElement>("[data-pane-id]")?.dataset
        .paneId;
    let w = browser
      ? getState().workspaces.find((w) => w.id === browser.workspaceId)
      : (getState().workspaces.find((w) =>
          w.panes.some((p) => p.id === focusedPaneId),
        ) ?? activeWorkspace());
    let pane = browser
      ? w?.panes.find((p) => p.id === browser.paneId)
      : (w?.panes.find((p) => p.id === focusedPaneId) ?? currentPane());
    if (context) {
      w = getState().workspaces.find((item) => item.id === context.workspaceId);
      pane = w?.panes.find((item) => item.id === context.paneId);
    }
    const conversation = context
      ? (getState().conversations.find(
          (item) => item.id === context.conversationId,
        ) ?? null)
      : (conversationTarget(pane) ?? null);
    const group = w?.groups?.find((g) =>
      g.paneIds.includes(pane?.id ?? w.activePaneId),
    );
    const linkUrl =
      context?.linkUrl ??
      (browserId ? undefined : focusedWebLink(document.activeElement));
    const reason = disabledReason(
      id,
      w ?? null,
      pane ?? null,
      conversation,
      linkUrl,
    );
    if (reason) {
      setStatus(reason);
      return;
    }
    try {
      const action = conversationCommand(id, conversation);
      if (action) {
        action.run();
        return;
      }
      const paneNumber = /^pane\.focus([1-9])$/.exec(id);
      if (paneNumber) {
        await keys.spatial(Number(paneNumber[1]) - 1, w?.id);
        return;
      }
      const tabNumber = /^tab\.focus([1-8])$/.exec(id);
      if (tabNumber) {
        await keys.selectTab(Number(tabNumber[1]) - 1, w?.id, pane?.id);
        return;
      }
      switch (id) {
        case "link.open":
          await invoke("browser.open", { workspace: w!.id, url: linkUrl! });
          break;
        case "browser.openExternal": {
          const current =
            pane?.kind === "browser"
              ? getState().browsers.find((item) => item.id === pane.browserId)
              : undefined;
          await invoke("browser.open-external", {
            url: linkUrl ?? current?.url,
          });
          break;
        }
        case "devtools.toggle":
          await window.cod.toggleDevTools(
            browserId ?? context?.devtoolsBrowserId,
          );
          break;
        case "palette":
          commandPalette();
          break;
        case "shortcuts.openFile":
          await window.cod.openKeymap();
          break;
        case "shortcuts":
          showKeyboardShortcuts(focus);
          break;
        case "settings": {
          const origin = focus.capture();
          appearanceDialog(() => {
            focus.restore(origin);
            showKeyboardShortcuts(focus);
          });
          break;
        }
        case "workspace.new":
          workspaceDialog("create");
          break;
        case "workspace.rename": {
          const target = context ? w : workspaceTarget(w);
          if (target) await navigation.renameWorkspace(target.id);
          break;
        }
        case "workspace.close": {
          const target = context ? w : workspaceTarget(w);
          if (target) navigation.closeWorkspace(target);
          break;
        }
        case "workspace.focusTree":
          await focusTargets.toggle("workspaces", focusIntent);
          break;
        case "workspace.reopen":
          reopenWorkspace();
          break;
        case "tab.new":
          await newTab(w?.id, group?.id);
          break;
        case "tab.chooseType": {
          const anchor = panes.querySelector<HTMLElement>(
            `[data-group-id="${group?.id}"] [data-action="new-tab"]`,
          );
          if (anchor) chooseTabType(anchor, w?.id, group?.id);
          break;
        }
        case "files.new":
          if (w && group) {
            await createTab(
              "file.new",
              {
                workspace: w.id,
                group: group.id,
                sourcePane: group.activePaneId,
              },
              focusIntent,
            );
          }
          break;
        case "chat.new":
          await newConversation();
          break;
        case "chat.width":
          chatWidthDialog();
          break;
        case "chat.send":
          sendActiveMessage(pane);
          break;
        case "chat.stop":
          if (pane?.kind === "conversation")
            await invoke("conversation.interrupt", { id: pane.conversationId });
          break;
        case "terminal.new":
          terminalDialog();
          break;
        case "browser.new":
          browserDialog();
          break;
        case "browser.bookmarks":
          browserBookmarks(invoke, async (url) => {
            if (w) await invoke("browser.open", { workspace: w.id, url });
          });
          break;
        case "browser.bookmark":
        case "browser.pin": {
          if (pane?.kind !== "browser")
            throw new Error("Focus a browser tab first");
          const browser = getState().browsers.find(
            (item) => item.id === pane.browserId,
          )!;
          await invoke(
            id === "browser.bookmark" ? "browser.bookmark" : "browser.pin",
            {
              url: browser.url,
              title: browser.title,
            },
          );
          break;
        }
        case "browser.downloads":
          browserDownloads(invoke);
          break;
        case "browser.permissions":
          await sitePermissions(
            invoke,
            pane?.kind === "browser"
              ? getState().browsers.find((b) => b.id === pane.browserId)?.url
              : undefined,
          );
          break;
        case "browser.settings":
          appearanceDialog(() => showKeyboardShortcuts(focus), "browser");
          break;
        case "browser.history":
          browserHistory(invoke, async (url) => {
            if (w) await invoke("browser.open", { workspace: w.id, url });
          });
          break;
        case "browser.default":
          defaultBrowserDialog();
          break;
        case "browser.address": {
          const input = panes.querySelector<HTMLInputElement>(
            `[data-pane-id="${pane?.id}"] input[aria-label="Address"]`,
          );
          // State can arrive before the queued render updates this field. Once
          // focused, passive renders intentionally preserve the user's edit.
          if (input && (browserId || document.activeElement !== input)) {
            const record =
              pane?.kind === "browser"
                ? getState().browsers.find((item) => item.id === pane.browserId)
                : undefined;
            if (record)
              input.value = record.url === "about:blank" ? "" : record.url;
          }
          input?.focus();
          input?.select();
          break;
        }
        case "folders.add":
          folderDialog();
          break;
        case "session.resume":
          resumeConversationDialog();
          break;
        case "integration.install":
          chats.integration();
          break;
        case "files.open":
          projects.quickOpen();
          break;
        case "files.search":
          projects.search();
          break;
        case "files.preview": {
          const host = panes.querySelector<HTMLElement>(
            `[data-pane-id="${pane?.id}"]`,
          );
          if (pane?.kind === "review")
            host
              ?.querySelector(".review-body")
              ?.dispatchEvent(new CustomEvent("cod:toggle-preview"));
          else if (
            w &&
            pane &&
            (pane.kind === "document" || pane.kind === "preview") &&
            pane.filePath
          )
            await invoke(
              pane.kind === "preview" ? "file.open" : "preview.open",
              { workspace: w.id, path: pane.filePath },
            );
          break;
        }
        case "files.save":
          if (w && pane) await features.saveFile(w.id, pane.id);
          break;
        case "review.document":
          if (w && pane?.kind === "document" && pane.filePath)
            await invoke("review.open-document", {
              workspace: w.id,
              path: pane.filePath,
            });
          break;
        case "review.addComment":
        case "review.submit": {
          const host = panes.querySelector<HTMLElement>(
            `[data-pane-id="${pane?.id}"]`,
          );
          host
            ?.querySelector(".review-body")
            ?.dispatchEvent(
              new CustomEvent(
                id === "review.addComment"
                  ? "cod:add-comment"
                  : "cod:submit-review",
                { bubbles: false },
              ),
            );
          break;
        }
        case "navigation.toggleFiles":
          layout.toggle("filesVisible");
          break;
        case "navigation.toggleWorkspaces":
          layout.toggle("workspacesVisible");
          break;
        case "focus.files":
          await focusTargets.toggle("files", focusIntent);
          break;
        case "focus.composer":
          await focusTargets.toggle("chat", focusIntent);
          break;
        case "focus.terminal":
          await focusTargets.toggle("terminal", focusIntent);
          break;
        case "pane.focusLeft":
        case "pane.focusRight": {
          const target = await layout.sidePane(
            id === "pane.focusLeft" ? "left" : "right",
          );
          if (target) await keys.focusPane(target, focusIntent);
          break;
        }
        case "pane.toggleRight":
        case "pane.toggleLeft": {
          await layout.togglePane(
            id === "pane.toggleLeft" ? "left" : "right",
            focusIntent.signal,
          );
          const active = activeWorkspace();
          if (active)
            await keys.focusActiveContent(active.activePaneId, focusIntent);
          break;
        }
        case "pane.next":
          await keys.cyclePane(1, w?.id, pane?.id);
          break;
        case "pane.previous":
          await keys.cyclePane(-1, w?.id, pane?.id);
          break;
        case "tab.last":
          await keys.selectTab(-1, w?.id, pane?.id);
          break;
        case "content.find":
          if (pane) features.find.open(pane);
          break;
        case "pane.nextRegion":
          await keys.cycleRegion(1, browserId);
          break;
        case "pane.previousRegion":
          await keys.cycleRegion(-1, browserId);
          break;
        case "pane.zoom":
          if (w && group)
            await invoke("group.zoom", { workspace: w.id, id: group.id });
          break;
        case "pane.splitRight":
        case "pane.splitDown":
          if (w && group && pane)
            await invoke("group.split", {
              workspace: w.id,
              id: group.id,
              paneId: pane.id,
              direction: id === "pane.splitRight" ? "right" : "down",
            });
          break;
        case "tab.next":
          await keys.cycleTab(1, w?.id, pane?.id);
          break;
        case "tab.previous":
          await keys.cycleTab(-1, w?.id, pane?.id);
          break;
        case "tab.togglePin":
          if (w && pane)
            await invoke("pane.pin", {
              workspace: w.id,
              id: pane.id,
              pinned: !pane.pinned,
            });
          break;
        case "tab.closeOthers":
        case "tab.closeAll":
          if (w && pane && group)
            await invoke("pane.close-many", {
              workspace: w.id,
              group: group.id,
              id: pane.id,
              scope: id === "tab.closeAll" ? "all" : "others",
            });
          break;
        case "tab.close":
          if (w && pane) {
            const result = await invoke<{ closed?: boolean }>("pane.close", {
              workspace: w.id,
              id: pane.id,
            });
            if (
              result.closed !== false &&
              !(await features.whenRendered(() => {
                const current = activeWorkspace();
                if (current?.id !== w.id) return false;
                return current.panes.some((item) => item.id === pane.id)
                  ? undefined
                  : true;
              }, focusIntent.signal))
            )
              break;
            const next = activeWorkspace();
            if (
              next &&
              !(result.closed === false && next.activePaneId === pane.id)
            )
              await keys.focusActiveContent(next.activePaneId, focusIntent);
          }
          break;
        case "tab.reopen":
          reopenTab(focusIntent);
          break;
        case "tab.reorderLeft":
        case "tab.reorderRight":
          if (w && group && pane)
            await invoke("pane.move", {
              workspace: w.id,
              id: pane.id,
              group: group.id,
              index: Math.max(
                0,
                Math.min(
                  group.paneIds.length - 1,
                  group.paneIds.indexOf(pane.id) +
                    (id === "tab.reorderLeft" ? -1 : 1),
                ),
              ),
            });
          break;
        case "tab.moveToPane":
          if (w && group && pane) {
            const targets = paneRegions(w).filter(
              (r) => r.id !== group.id && !r.id.startsWith("missing-"),
            );
            menu(
              document.querySelector<HTMLElement>(
                `[data-tab-id="${pane.id}"]`,
              ) ?? document.querySelector<HTMLElement>("#workspace-selector")!,
              targets.map((target, index) => ({
                label: `Move to pane ${index + 1}`,
                run: () =>
                  void invoke("pane.move", {
                    workspace: w.id,
                    id: pane.id,
                    group: target.id,
                  }).then(() => keys.focusPane(pane.id)),
              })),
            );
          }
          break;
        case "text.inc":
          changeTextSize(1);
          break;
        case "text.dec":
          changeTextSize(-1);
          break;
        case "text.reset":
          changeTextSize("reset");
          break;
      }
    } catch (error) {
      showActionError(
        error,
        panes.querySelector(`[data-pane-id="${pane?.id}"]`) ?? panes,
      );
    }
  }
  function commandPalette(): void {
    if (document.querySelector("dialog[open]")) return;
    const returnFocus = focus.capture();
    const workspace = workspaceTarget();
    const conversation = conversationTarget();
    const context: CommandContext = {
      linkUrl: returnFocus.browserId
        ? undefined
        : focusedWebLink(returnFocus.element ?? document.activeElement),
      devtoolsBrowserId: returnFocus.browserId,
      workspaceId: workspace?.id,
      paneId:
        getState().browsers.find((item) => item.id === focusedTreeId())
          ?.paneId ??
        conversation?.paneId ??
        workspace?.activePaneId,
      conversationId: conversation?.id,
    };
    let performed = false;
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "Command palette");
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Filter commands");
    input.placeholder = "Type a command";
    const list = document.createElement("div");
    list.className = "command-list";
    const definitions = commandDefinitions.filter(
      (command) => command.id !== "palette",
    );
    const buttons = new Map<CommandId, HTMLButtonElement>();
    for (const definition of definitions) {
      const name = definition.title;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = name;
      button.setAttribute("aria-label", name);
      const shortcut = formatShortcut(definition.id, keyboardPlatform);
      if (shortcut) {
        const hint = document.createElement("kbd");
        hint.textContent = shortcut;
        hint.setAttribute("aria-hidden", "true");
        button.append(hint);
      }
      button.dataset.command =
        `${name} ${definition.aliases.join(" ")}`.toLowerCase();
      button.addEventListener("click", () => {
        performed = true;
        dialog.close();
        // The next dialog must inherit the original invoker, not the palette
        // or a transient native focus restoration while close is dispatched.
        focus.restore(returnFocus);
        void execute(definition.id, undefined, context);
      });
      buttons.set(definition.id, button);
      list.append(button);
    }
    const selection = createSearchList(input, list);
    selection.update();
    const refresh = () => {
      const workspace = getState().workspaces.find(
        (item) => item.id === context.workspaceId,
      );
      const pane = workspace?.panes.find((item) => item.id === context.paneId);
      const conversation =
        getState().conversations.find(
          (item) => item.id === context.conversationId,
        ) ?? null;
      const previous = document.getElementById(
        input.getAttribute("aria-activedescendant") ?? "",
      ) as HTMLButtonElement | null;
      let changed = false;
      for (const [id, button] of buttons) {
        const reason = disabledReason(
          id,
          workspace ?? null,
          pane ?? null,
          conversation,
          context.linkUrl,
        );
        if (button.disabled === !!reason && button.title === (reason ?? ""))
          continue;
        changed = true;
        button.disabled = !!reason;
        button.title = reason ?? "";
        let hint = button.querySelector<HTMLElement>(
          ".command-disabled-reason",
        );
        if (reason) {
          if (!hint) {
            hint = document.createElement("small");
            hint.className = "command-disabled-reason";
            button.append(hint);
          }
          hint.textContent = reason;
        } else hint?.remove();
      }
      if (changed) selection.update(previous ?? undefined);
    };
    refreshPalette = refresh;
    refresh();
    input.addEventListener("input", () => {
      for (const button of list.querySelectorAll<HTMLButtonElement>("button")) {
        button.hidden = !button.dataset.command!.includes(
          input.value.toLowerCase(),
        );
      }
      selection.update();
    });
    dialog.classList.add("picker", "command-palette", "search-picker");
    dialog.append(input, list);
    document.body.append(dialog);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      dialog.close();
      // Restore the invoker's caret now; the native close event may arrive
      // after a newer focus command or another edit in that same control.
      if (!performed) focus.restore(returnFocus);
    });
    dialog.addEventListener("close", () => {
      const restore =
        dialog.contains(document.activeElement) ||
        document.activeElement === document.body;
      dialog.remove();
      if (refreshPalette === refresh) refreshPalette = undefined;
      if (!performed && restore) focus.restore(returnFocus);
    });
    dialog.showModal();
    input.focus();
  }

  function focusPanel(): void {
    const focus = () => {
      const selected = tree.querySelector<HTMLElement>("[aria-selected=true]");
      (selected ?? tree.querySelector<HTMLElement>("[role=treeitem]"))?.focus();
    };
    const workspace = activeWorkspace();
    if (
      workspace &&
      (workspace.settings?.workspacesVisible === false ||
        workspace.zoomedGroupId)
    )
      void invoke("workspace.settings", {
        id: workspace.id,
        settings: { workspacesVisible: true },
      }).then(() => requestAnimationFrame(focus));
    else focus();
  }

  const workspaceSelector = document.querySelector<HTMLButtonElement>(
    "#workspace-selector",
  )!;
  workspaceSelector.setAttribute("aria-label", "Overview");
  workspaceSelector.setAttribute("aria-haspopup", "dialog");
  workspaceSelector.setAttribute("aria-expanded", "false");
  workspaceSelector.title = shortcutTitle("workspace.overview");
  document.addEventListener(
    "cod:keymap-changed",
    () => {
      workspaceSelector.title = shortcutTitle("workspace.overview");
      refreshPalette?.();
    },
    { signal: events.signal },
  );
  workspaceSelector.addEventListener("click", () => overview.toggle(), {
    signal: events.signal,
  });
  listen(
    "keydown",
    (event) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.getModifierState("AltGraph")
      )
        return;
      if (
        event.key === "ContextMenu" ||
        (event.shiftKey &&
          event.key === "F10" &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey)
      ) {
        const target = document.activeElement;
        if (target?.closest(".workspace-overview")) return;
        if (target instanceof HTMLElement) {
          event.preventDefault();
          event.stopPropagation();
          const rect = target.getBoundingClientRect();
          target.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: rect.left,
              clientY: rect.bottom,
            }),
          );
        }
        return;
      }
      const openDialog = [...document.querySelectorAll("dialog[open]")].at(-1);
      if (openDialog && !openDialog.classList.contains("workspace-overview"))
        return;
      const match = resolveKeybinding(
        {
          ...event,
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          repeat: event.repeat,
          isComposing: event.isComposing,
          altGraph: event.getModifierState("AltGraph"),
        },
        keyboardPlatform,
        keyboardSurface(),
      );
      if (!match || (openDialog && match.command !== "workspace.overview"))
        return;
      event.preventDefault();
      event.stopPropagation();
      if (match.dispatch) void execute(match.command);
    },
    true,
  );
  return {
    settings: () => execute("settings"),
    execute,
    refresh: () => {
      refreshPalette?.();
      overview.refresh();
      workspaceSelector.title = shortcutTitle("workspace.overview");
    },
    dispose: () => {
      refreshPalette = undefined;
      overview.dispose();
      events.abort();
      focusTargets.dispose();
      keys.dispose();
    },
    palette: commandPalette,
    focusPanel,
    focusComposer: focusActiveComposer,
    newConversation,
    newTab,
    chooseTabType,
    browser: browserDialog,
    terminal: terminalDialog,
    folder: folderDialog,
    workspace: workspaceDialog,
    conversationActions,
  };
}
