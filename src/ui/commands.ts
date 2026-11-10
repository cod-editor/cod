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
} from "./keyboard-ui";
import { createKeyboardNavigation } from "./keyboard-navigation";
import { paneRegions } from "./pane-layout";
import { createSearchList } from "./search-list";
import { appearanceDialog, changeTextSize } from "./appearance";
import { inputDialog, confirmAction } from "./dialogs";
import { actionButton as paneButton, showActionError } from "./action-feedback";
import { menu, type MenuAction } from "./controls";
import type { AppState } from "../types";
import type { Invoke } from "./contracts";
import type { createFocusManager } from "./focus";
interface CommandFeatures {
  focus: ReturnType<typeof createFocusManager>;
  files: { quickOpen: () => void; search: () => void };
  layout: {
    toggle: (key: "filesVisible" | "workspacesVisible") => void;
    split: (direction: "right" | "down") => void;
    zoom: () => void;
    togglePane: (side: "left" | "right") => Promise<void>;
    paneToggleReason: (side: "left" | "right") => string | undefined;
  };
  chat: { send: (id: string) => Promise<void>; integration: () => void };
  navigation: { focusWorkspace: (id: string) => Promise<void> };
  saveFile: (workspace: string, pane: string) => Promise<void>;
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
  );
  const events = new AbortController();
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
  function moveConversation(
    conversation: import("../types").ConversationState,
  ): void {
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
    conversation: import("../types").ConversationState,
  ): MenuAction[] {
    if (conversation.handoffTerminalId) {
      const terminal = getState().terminals.find(
        (t) => t.id === conversation.handoffTerminalId,
      );
      return [
        {
          label: "Open CLI terminal",
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
          disabled:
            !!terminal && ["running", "starting"].includes(terminal.status),
          run: () =>
            void invoke("conversation.reclaim", { id: conversation.id }),
        },
      ];
    }
    return [
      {
        label: "Move to workspace...",
        disabled: getState().workspaces.length < 2,
        run: () => moveConversation(conversation),
      },
      {
        label: "Continue in CLI",
        disabled: ["working", "waiting", "starting"].includes(
          conversation.status,
        ),
        run: () => void invoke("conversation.handoff", { id: conversation.id }),
      },
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
  async function newConversation(): Promise<unknown> {
    const result = await invoke("conversation.draft", {});
    focusActiveComposer();
    return result;
  }

  function reopenTab(): void {
    const w = activeWorkspace();
    if (!w) return;
    const closed = w.closedTabs?.at(-1);
    if (closed?.terminal)
      confirmAction(
        "Start a new shell?",
        `Start a new shell in ${closed.terminal.cwd}? The previous process has ended; commands will not be replayed.`,
        "Start shell",
        () => invoke("pane.reopen", { workspace: w.id, newShell: true }),
      );
    else void invoke("pane.reopen", { workspace: w.id });
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
  function sendActiveMessage(): void {
    const w = activeWorkspace();
    const pane = w?.panes.find((p) => p.id === w.activePaneId);
    if (pane?.kind === "conversation") void chats.send(pane.conversationId);
    else
      panes
        .querySelector<HTMLTextAreaElement>(
          '[data-pane-id="' +
            w?.activePaneId +
            '"] textarea[aria-label="Message"]',
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

  function browserDialog(): void {
    const workspace = activeWorkspace();
    if (!workspace) return;
    inputDialog({
      title: "New browser",
      label: "URL",
      value: "https://",
      submitLabel: "Open",
      submit: (url) =>
        localInvoke("browser.open", { workspace: workspace.id, url }),
    });
  }

  function resumeConversationDialog(): void {
    const workspace = activeWorkspace();
    if (!workspace) return;
    const dialog = document.createElement("dialog");
    dialog.className = "session-picker";
    dialog.setAttribute("aria-label", "Open existing session");
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
    const search = document.createElement("button");
    search.type = "submit";
    search.textContent = "Find sessions";
    form.append(provider, cwd, search);
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    const list = document.createElement("div");
    list.className = "command-list";
    const manual = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Open by session ID";
    const nativeId = document.createElement("input");
    nativeId.setAttribute("aria-label", "Native session ID");
    nativeId.placeholder = "Native session ID";
    const resume = async (
      id: string,
      directory?: string,
      selectedProvider = provider.value,
    ) => {
      status.textContent = "Opening session...";
      try {
        await localInvoke("conversation.resume", {
          workspace: workspace.id,
          provider: selectedProvider,
          nativeId: id,
          ...(directory
            ? { cwd: directory }
            : cwd.value
              ? { cwd: cwd.value }
              : {}),
        });
        dialog.close();
      } catch (error) {
        status.textContent = String(error);
      }
    };
    const open = paneButton("Open session", async () => {
      if (nativeId.value.trim()) await resume(nativeId.value.trim());
    });
    manual.append(summary, nativeId, open);
    const cancel = paneButton("Cancel", async () => dialog.close());
    dialog.append(heading, form, status, list, manual, cancel);
    document.body.append(dialog);
    dialog.onclose = () => dialog.remove();
    let generation = 0;
    provider.onchange = () => {
      ++generation;
      list.replaceChildren();
      form.requestSubmit();
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      const current = ++generation;
      search.disabled = true;
      status.textContent = "Finding sessions...";
      void localInvoke<import("../providers/types").Conversation[]>(
        "conversation.discover",
        {
          workspace: workspace.id,
          provider: provider.value,
          ...(cwd.value ? { cwd: cwd.value } : {}),
        },
      )
        .then((sessions) => {
          if (current !== generation) return;
          list.replaceChildren();
          status.textContent = sessions.length
            ? ""
            : "No sessions found in this directory.";
          for (const session of sessions) {
            const metadata = session.metadata as Record<string, unknown> | null;
            const label = String(
              metadata?.name ??
                metadata?.title ??
                metadata?.preview ??
                session.nativeId,
            );
            const button = paneButton(label, () =>
              resume(session.nativeId, session.cwd, session.provider),
            );
            button.title = `${session.nativeId}\n${session.cwd}`;
            list.append(button);
          }
        })
        .catch((error) => (status.textContent = String(error)))
        .finally(() => (search.disabled = false));
    };
    dialog.showModal();
    provider.focus();
    form.requestSubmit();
  }

  function terminalDialog(): void {
    const workspace = activeWorkspace();
    if (!workspace) return;
    inputDialog({
      title: "New terminal",
      label: "Working directory",
      value: workspace.folders[0] ?? "",
      submitLabel: "Create",
      submit: (cwd) =>
        localInvoke("terminal.open", {
          workspace: workspace.id,
          cwd,
        }),
    });
  }
  let choosingFolder = false;
  function folderDialog(workspaceId = activeWorkspace()?.id): void {
    if (!workspaceId || choosingFolder) return;
    choosingFolder = true;
    const returnFocus = focus.capture();
    void window.cod
      .chooseDirectory()
      .then(async (path) => {
        if (path !== null)
          await localInvoke("workspace.add-folder", { id: workspaceId, path });
      })
      .catch((error) =>
        showActionError(error, panes.querySelector("[data-pane-id]") ?? panes),
      )
      .finally(() => {
        choosingFolder = false;
        focus.restore(returnFocus);
      });
  }
  function workspaceDialog(mode: "create" | "rename"): void {
    const workspace = activeWorkspace();
    if (mode === "rename" && !workspace) return;
    inputDialog({
      title: mode === "create" ? "New workspace" : "Rename workspace",
      label: "Workspace name",
      value: mode === "rename" ? workspace!.name : "",
      submitLabel: mode === "create" ? "Create" : "Save",
      submit: (name) =>
        mode === "create"
          ? localInvoke("workspace.create", { name })
          : localInvoke("workspace.rename", { id: workspace!.id, name }),
      completed: () => {
        if (mode === "create") focusActiveComposer();
      },
    });
  }
  const currentPane = () => {
    const w = activeWorkspace();
    return w?.panes.find((p) => p.id === w.activePaneId);
  };
  function disabledReason(
    id: CommandId,
    w = activeWorkspace(),
    pane = currentPane(),
  ): string | undefined {
    const group = w?.groups?.find((g) => g.paneIds.includes(w.activePaneId));
    if (
      [
        "palette",
        "shortcuts",
        "settings",
        "workspace.new",
        "chat.new",
        "integration.install",
        "browser.default",
        "workspace.reopen",
        "text.inc",
        "text.dec",
        "text.reset",
      ].includes(id)
    )
      return;
    if (!w) return "Open a workspace first";
    if (id === "pane.toggleLeft" || id === "pane.toggleRight")
      return layout.paneToggleReason(
        id === "pane.toggleLeft" ? "left" : "right",
      );
    if (
      ["chat.send", "chat.stop", "focus.composer"].includes(id) &&
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
      ["files.save", "review.document"].includes(id) &&
      !(pane?.kind === "document" && pane.filePath)
    )
      return "Select an editable file first";
    if (id === "browser.address" && pane?.kind !== "browser")
      return "Select a browser tab first";
    if (id === "pane.focus2" && (w.groups?.length ?? 0) < 2)
      return "Open a second pane first";
    if (id === "tab.moveToPane" && (w.groups?.length ?? 0) < 2)
      return "Open a second pane first";
    if (
      id === "tab.reorderLeft" &&
      (!group || group.paneIds.indexOf(w.activePaneId) <= 0)
    )
      return "Already the first tab";
    if (
      id === "tab.reorderRight" &&
      (!group ||
        group.paneIds.indexOf(w.activePaneId) >= group.paneIds.length - 1)
    )
      return "Already the last tab";
    if (
      ["review.addComment", "review.submit"].includes(id) &&
      pane?.kind !== "review"
    )
      return "Select a review first";
  }
  async function execute(id: CommandId, browserId?: string): Promise<void> {
    if (browserId) focus.native(browserId);
    if (document.querySelector("dialog[open]")) return;
    const browser = browserId
      ? getState().browsers.find((b) => b.id === browserId)
      : undefined;
    if (browserId && !browser) return;
    const focusedPaneId =
      document.activeElement?.closest<HTMLElement>("[data-pane-id]")?.dataset
        .paneId;
    const w = browser
      ? getState().workspaces.find((w) => w.id === browser.workspaceId)
      : (getState().workspaces.find((w) =>
          w.panes.some((p) => p.id === focusedPaneId),
        ) ?? activeWorkspace());
    const pane = browser
      ? w?.panes.find((p) => p.id === browser.paneId)
      : (w?.panes.find((p) => p.id === focusedPaneId) ?? currentPane());
    const group = w?.groups?.find((g) =>
      g.paneIds.includes(pane?.id ?? w.activePaneId),
    );
    const reason = disabledReason(id, w, pane);
    if (reason) {
      setStatus(reason);
      return;
    }
    try {
      switch (id) {
        case "palette":
          commandPalette();
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
        case "workspace.rename":
          workspaceDialog("rename");
          break;
        case "workspace.focusTree":
          focusPanel();
          break;
        case "workspace.reopen":
          reopenWorkspace();
          break;
        case "chat.new":
          await newConversation();
          break;
        case "chat.width":
          chatWidthDialog();
          break;
        case "chat.send":
          sendActiveMessage();
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
        case "browser.default":
          defaultBrowserDialog();
          break;
        case "browser.address": {
          const input = panes.querySelector<HTMLInputElement>(
            `[data-pane-id="${pane?.id}"] input[aria-label="Address"]`,
          );
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
          if (w?.settings?.filesVisible !== true)
            await invoke("workspace.settings", {
              id: w!.id,
              settings: { filesVisible: true },
            });
          requestAnimationFrame(() => {
            const files = document.querySelector<HTMLElement>("#project-panel");
            (
              files?.querySelector<HTMLElement>(
                '[role="treeitem"][tabindex="0"]',
              ) ??
              files?.querySelector<HTMLElement>('[role="treeitem"]') ??
              files
            )?.focus();
          });
          break;
        case "focus.composer":
          focusActiveComposer();
          break;
        case "pane.toggleLeft":
        case "pane.toggleRight": {
          const focused = document.activeElement;
          await layout.togglePane(id === "pane.toggleLeft" ? "left" : "right");
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          if (
            browserId ||
            (focused instanceof HTMLElement && !focused.getClientRects().length)
          ) {
            const active = activeWorkspace();
            if (active) await keys.focusPane(active.activePaneId);
          }
          break;
        }
        case "pane.focus1":
          await keys.spatial(0, w?.id);
          break;
        case "pane.focus2":
          await keys.spatial(1, w?.id);
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
          layout.split("right");
          break;
        case "pane.splitDown":
          layout.split("down");
          break;
        case "tab.next":
          await keys.cycleTab(1, w?.id, pane?.id);
          break;
        case "tab.previous":
          await keys.cycleTab(-1, w?.id, pane?.id);
          break;
        case "tab.close":
          if (w && pane) {
            await invoke("pane.close", { workspace: w.id, id: pane.id });
            const next = activeWorkspace();
            if (next) await keys.focusPane(next.activePaneId);
          }
          break;
        case "tab.reopen":
          reopenTab();
          break;
        case "tab.reorderLeft":
        case "tab.reorderRight":
          if (w && group)
            await invoke("pane.move", {
              workspace: w.id,
              id: w.activePaneId,
              group: group.id,
              index:
                group.paneIds.indexOf(w.activePaneId) +
                (id === "tab.reorderLeft" ? -1 : 1),
            });
          break;
        case "tab.moveToPane":
          if (w && group) {
            const targets = paneRegions(w).filter(
              (r) => r.id !== group.id && !r.id.startsWith("missing-"),
            );
            menu(
              document.querySelector<HTMLElement>(
                `[data-tab-id="${w.activePaneId}"]`,
              ) ?? document.querySelector<HTMLElement>("#workspace-selector")!,
              targets.map((target, index) => ({
                label: `Move to pane ${index + 1}`,
                run: () =>
                  void invoke("pane.move", {
                    workspace: w.id,
                    id: w.activePaneId,
                    group: target.id,
                  }).then(() => keys.focusPane(w.activePaneId)),
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
      const reason = disabledReason(definition.id);
      button.disabled = !!reason;
      if (reason) {
        button.title = reason;
        const hint = document.createElement("small");
        hint.className = "command-disabled-reason";
        hint.textContent = reason;
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
        void execute(definition.id);
      });
      list.append(button);
    }
    const selection = createSearchList(input, list);
    selection.update();
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
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (!performed) focus.restore(returnFocus);
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
    if (workspace?.settings?.workspacesVisible === false)
      void invoke("workspace.settings", {
        id: workspace.id,
        settings: { workspacesVisible: true },
      }).then(() => requestAnimationFrame(focus));
    else focus();
  }

  document.querySelector("#workspace-selector")!.addEventListener(
    "click",
    () => {
      const dialog = document.createElement("dialog");
      dialog.className = "workspace-picker picker";
      dialog.setAttribute("aria-label", "Switch workspace");
      const input = document.createElement("input");
      input.placeholder = "Search workspaces...";
      input.setAttribute("aria-label", "Search workspaces");
      const list = document.createElement("div");
      list.className = "command-list";
      const selection = createSearchList(input, list);
      const fill = () => {
        list.replaceChildren();
        let current: HTMLButtonElement | undefined;
        for (const w of getState().workspaces.filter((w) =>
          w.name.toLowerCase().includes(input.value.toLowerCase()),
        )) {
          const button = document.createElement("button");
          button.textContent = w.name;
          if (w.id === getState().activeWorkspaceId) current = button;
          button.onclick = () => {
            dialog.close();
            void navigation.focusWorkspace(w.id);
          };
          list.append(button);
        }
        const create = document.createElement("button");
        create.textContent = "New workspace";
        create.onclick = () => {
          dialog.close();
          workspaceDialog("create");
        };
        list.append(document.createElement("hr"), create);
        selection.update(input.value ? undefined : current);
      };
      input.oninput = fill;
      dialog.append(input, list);
      document.body.append(dialog);
      dialog.onclose = () => dialog.remove();
      fill();
      dialog.showModal();
      input.focus();
    },
    { signal: events.signal },
  );
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
      if (document.querySelector("dialog[open]")) return;
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
      if (!match) return;
      event.preventDefault();
      event.stopPropagation();
      if (match.dispatch) void execute(match.command);
    },
    true,
  );
  return {
    settings: () => execute("settings"),
    execute,
    dispose: () => events.abort(),
    palette: commandPalette,
    focusPanel,
    focusComposer: focusActiveComposer,
    newConversation,
    browser: browserDialog,
    terminal: terminalDialog,
    folder: folderDialog,
    workspace: workspaceDialog,
    conversationActions,
  };
}
