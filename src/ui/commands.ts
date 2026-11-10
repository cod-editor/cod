import { createSearchList } from "./search-list";
import { appearanceDialog, changeTextSize } from "./appearance";
import { inputDialog, confirmAction } from "./dialogs";
import { actionButton as paneButton, showActionError } from "./action-feedback";
import type { MenuAction } from "./controls";
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
  };
  chat: { send: (id: string) => Promise<void>; integration: () => void };
  navigation: { focusWorkspace: (id: string) => Promise<void> };
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
        ?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
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
    const commands = [
      ["Settings...", appearanceDialog],
      ["Increase text size", () => changeTextSize(1)],
      ["Decrease text size", () => changeTextSize(-1)],
      ["Reset text size", () => changeTextSize("reset")],
      ["New workspace", () => workspaceDialog("create")],
      ["New chat", () => newConversation()],
      ["New terminal", terminalDialog],
      ["New browser", browserDialog],
      ["Add folder", folderDialog],
      [
        "Review active document",
        () => {
          const workspace = activeWorkspace();
          const pane = workspace?.panes.find(
            (p) => p.id === workspace.activePaneId,
          );
          if (workspace && pane?.kind === "document" && pane.filePath)
            void invoke("review.open-document", {
              workspace: workspace.id,
              path: pane.filePath,
            }).catch(() => undefined);
        },
      ],
      ["Rename workspace", () => workspaceDialog("rename")],
      ["Open existing native session", resumeConversationDialog],
      ["Open file", () => projects.quickOpen()],
      ["Search in files", () => projects.search()],
      ["Chat maximum width", chatWidthDialog],
      ["Install agent integration...", () => chats.integration()],
      ["Default browser...", defaultBrowserDialog],
      ["Toggle files", () => layout.toggle("filesVisible")],
      ["Toggle workspaces", () => layout.toggle("workspacesVisible")],
      ["Send message", sendActiveMessage],
      ["Split right", () => layout.split("right")],
      ["Split below", () => layout.split("down")],
      ["Maximize / restore pane", () => layout.zoom()],
      ["Reopen closed tab", reopenTab],
      ["Reopen closed workspace", reopenWorkspace],
      ["Focus workspace panel", focusPanel],
    ] as const;
    const modifier = /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";
    const shortcuts: Record<string, string> = {
      "Settings...": ",",
      "Increase text size": "+",
      "Decrease text size": "-",
      "Reset text size": "0",
      "New workspace": "Shift+N",
      "Open file": "P",
      "Search in files": "Shift+F",
      "Send message": "Enter",
      "Maximize / restore pane": "Shift+Escape",
      "Reopen closed tab": "Shift+T",
      "Focus workspace panel": "Shift+E",
    };
    for (const [name, action] of commands) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = name;
      button.setAttribute("aria-label", name);
      if (shortcuts[name]) {
        const hint = document.createElement("kbd");
        hint.textContent =
          modifier +
          (modifier === "⌘"
            ? shortcuts[name]
                .replace("Shift+", "⇧")
                .replace("Enter", "↵")
                .replace("Escape", "Esc")
            : shortcuts[name]);
        hint.setAttribute("aria-hidden", "true");
        button.append(hint);
      }
      button.dataset.command =
        `${name} ${name === "New chat" ? "new conversation open chat start chat new session open session start session" : ""}`.toLowerCase();
      button.addEventListener("click", () => {
        performed = true;
        dialog.close();
        // The next dialog must inherit the original invoker, not the palette
        // or a transient native focus restoration while close is dispatched.
        focus.restore(returnFocus);
        action();
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

  listen(
    "keydown",
    (event) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        !event.shiftKey ||
        document.querySelector("dialog[open]")
      )
        return;
      if (event.key.toLowerCase() === "e") {
        event.preventDefault();
        focusPanel();
      } else if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        commandPalette();
      }
    },
    true,
  );

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
        !(event.ctrlKey || event.metaKey) ||
        document.querySelector("dialog[open]")
      )
        return;
      const key = event.key.toLowerCase();
      if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        projects.quickOpen();
      } else if (key === "f" && event.shiftKey) {
        event.preventDefault();
        projects.search();
      } else if (key === "n" && event.shiftKey) {
        event.preventDefault();
        workspaceDialog("create");
      } else if (key === "t" && event.shiftKey) {
        event.preventDefault();
        reopenTab();
      } else if (key === "w") {
        event.preventDefault();
        const w = activeWorkspace();
        if (w)
          void invoke("pane.close", { workspace: w.id, id: w.activePaneId });
      } else if (event.key === "Escape" && event.shiftKey) {
        event.preventDefault();
        layout.zoom();
      } else if (key === "l") {
        const address = panes.querySelector<HTMLInputElement>(
          '[data-active="true"] input[aria-label="Address"]',
        );
        if (address) {
          event.preventDefault();
          address.focus();
          address.select();
        }
      }
    },
    true,
  );

  listen("keydown", (event) => {
    if (event.shiftKey && event.key === "F10") {
      const element = document.activeElement;
      if (element instanceof HTMLElement) {
        event.preventDefault();
        const rect = element.getBoundingClientRect();
        element.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: rect.left,
            clientY: rect.bottom,
          }),
        );
      }
    }
  });

  listen("keydown", (event) => {
    if (
      !(event.metaKey || event.ctrlKey) ||
      event.altKey ||
      document.querySelector("dialog[open]")
    )
      return;
    if (event.key === ",") {
      event.preventDefault();
      appearanceDialog();
    } else if (["+", "=", "-", "0"].includes(event.key)) {
      event.preventDefault();
      changeTextSize(event.key === "0" ? "reset" : event.key === "-" ? -1 : 1);
    }
  });
  return {
    settings: appearanceDialog,
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
