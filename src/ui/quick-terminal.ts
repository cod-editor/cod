import { isPlainEscape } from "../keyboard";
import { dialogSurface, iconButton, selectField, uiButton } from "../ui-kit";
import type { AppState, TerminalProcessState } from "../types";
import type { DesktopOperationName, Invoke } from "./contracts";
import type { createFocusManager } from "./focus";
import { shortcutTitle } from "./keyboard-ui";
import type { createTerminalViews } from "./terminal-views";

type Location = "local" | "linux";
type Shell = { record: TerminalProcessState; view: HTMLElement };
type QuickWorkspace = {
  id: string;
  alias?: string;
  location: Location;
  shells: Partial<Record<Location, Shell>>;
};

export function createQuickTerminal(
  state: () => AppState,
  invoke: Invoke,
  terminals: ReturnType<typeof createTerminalViews>,
  focus: ReturnType<typeof createFocusManager>,
  stageBrowserBackdrop: (dialog: HTMLDialogElement) => Promise<void>,
) {
  const workspaces = new Map<string, QuickWorkspace>();
  let current:
    | {
        workspace: QuickWorkspace;
        refresh: () => void;
        hide: (restore: boolean) => void;
      }
    | undefined;

  const trigger = iconButton("terminal", "Quick Terminal", toggle);
  trigger.classList.add("quick-terminal-trigger");
  trigger.disabled = true;
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  // Mouse activation preserves the focused pane. Keyboard activation can
  // return directly to the trigger.
  trigger.onpointerdown = (event) => event.preventDefault();
  const updateShortcut = () => {
    trigger.title = shortcutTitle("terminal.quickToggle");
  };
  updateShortcut();
  document.addEventListener("cod:keymap-changed", updateShortcut);

  function remoteAlias(id: string) {
    const remote = state().remoteWorkspace;
    return remote?.ids.includes(id) ? remote.alias : undefined;
  }

  function connected(workspace: QuickWorkspace) {
    return (
      remoteAlias(workspace.id) === workspace.alias &&
      state().remoteWorkspace?.connected === true
    );
  }

  function forget(shell: Shell) {
    terminals.remove(shell.record.id);
    shell.view.remove();
  }

  function getWorkspace(id: string): QuickWorkspace {
    const alias = remoteAlias(id);
    const saved = workspaces.get(id);
    if (saved?.alias === alias && saved) return saved;
    if (saved) for (const shell of Object.values(saved.shells)) forget(shell);
    const workspace: QuickWorkspace = {
      id,
      alias,
      location: alias ? "linux" : "local",
      shells: {},
    };
    workspaces.set(id, workspace);
    return workspace;
  }

  function toggle() {
    if (current) {
      current.hide(true);
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    const id = state().activeWorkspaceId;
    if (!id) return;
    const workspace = getWorkspace(id);
    const origin = focus.capture();
    const dialog = dialogSurface("Quick Terminal");
    dialog.className = "ui-dialog quick-terminal";
    dialog.dataset.browserBackdrop = "preserve";
    const header = document.createElement("header");
    header.className = "ui-dialog-header quick-terminal-header";
    const hideButton = iconButton("close", "Hide Quick Terminal", () =>
      hide(true),
    );
    if (workspace.alias) {
      const select = document.createElement("select");
      select.setAttribute("aria-label", "Quick Terminal host");
      select.append(
        new Option("Local", "local"),
        new Option(workspace.alias, "linux"),
      );
      select.value = workspace.location;
      select.onchange = () => {
        workspace.location = select.value === "linux" ? "linux" : "local";
        void showShell();
      };
      header.append(selectField(select));
    } else {
      const local = document.createElement("span");
      local.textContent = "Local";
      header.append(local);
    }
    header.append(hideButton);
    const body = document.createElement("div");
    body.className = "quick-terminal-body";
    const footer = document.createElement("footer");
    footer.className = "ui-dialog-actions quick-terminal-footer";
    const status = document.createElement("span");
    status.setAttribute("role", "status");
    const reconnect = uiButton("Reconnect", "quiet");
    reconnect.onclick = async () => {
      const revision = intent;
      reconnect.disabled = true;
      error = undefined;
      refresh();
      try {
        await invoke("remote.reconnect-current", {}, { reportError: false });
      } catch (cause) {
        if (intent === revision)
          error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        reconnect.disabled = false;
        refresh();
      }
    };
    footer.append(status, reconnect);
    dialog.append(header, body, footer);
    let intent = 0;
    let staged: Promise<void>;
    let loading = false;
    let error: string | undefined;
    let wasConnected = connected(workspace);

    function hide(restore: boolean) {
      if (current?.workspace !== workspace || !dialog.open) return;
      current = undefined;
      trigger.setAttribute("aria-expanded", "false");
      ++intent;
      body.replaceChildren();
      dialog.close();
      dialog.remove();
      if (restore && state().activeWorkspaceId === id) focus.restore(origin);
    }

    function refresh() {
      if (!dialog.open) return;
      const shell = workspace.shells[workspace.location];
      const attached = connected(workspace);
      const lost = workspace.location === "linux" && !attached;
      if (shell) {
        const metadata = state().quickTerminals?.find(
          ({ id }) => id === shell.record.id,
        );
        if (metadata) shell.record.status = metadata.status;
      }
      const rejoined =
        !wasConnected && attached && workspace.location === "linux";
      wasConnected = attached;
      reconnect.hidden = !lost;
      status.textContent =
        error ??
        (lost
          ? `Disconnected from ${workspace.alias}`
          : loading
            ? "Starting shell…"
            : shell?.record.status === "exited"
              ? "Shell exited. Reopen Quick Terminal to start another."
              : "");
      footer.hidden = !status.textContent && reconnect.hidden;
      if (rejoined) void showShell();
    }

    async function showShell() {
      const location = workspace.location;
      const revision = ++intent;
      const invoker = document.activeElement;
      const replacingInput = body.contains(invoker);
      const invokingSelect = invoker?.closest("select");
      await staged;
      if (revision !== intent || !dialog.open) return;
      error = undefined;
      const previous = workspace.shells[location];
      if (body.firstElementChild !== (previous?.view ?? null))
        body.replaceChildren(...(previous ? [previous.view] : []));
      if (location === "linux" && !connected(workspace)) {
        loading = false;
        if (previous) terminals.focus(previous.record.id);
        else reconnect.focus();
        refresh();
        return;
      }
      loading = !previous || previous.record.status !== "running";
      refresh();
      try {
        const record = await invoke<TerminalProcessState>(
          "terminal.quick-open",
          { workspace: id, location },
          { reportError: false },
        );
        if (revision !== intent || !dialog.open) return;
        let shell = previous;
        if (shell?.record.id !== record.id) {
          if (shell) forget(shell);
          const view = document.createElement("div");
          view.className = "quick-terminal-session";
          shell = { record, view };
          const binding = shell;
          workspace.shells[location] = binding;
          body.replaceChildren(view);
          const operation: Invoke = async <T>(
            op: DesktopOperationName,
            values?: Record<string, unknown>,
            options?: { reportError?: boolean },
          ) => {
            const result = await invoke<T>(
              op,
              {
                ...values,
                ...(location === "linux" ? { workspace: id } : {}),
              },
              { ...options, reportError: false },
            );
            if (op === "terminal.resize") {
              binding.record.cols = Number(values?.cols);
              binding.record.rows = Number(values?.rows);
            }
            return result;
          };
          terminals.create(view, record, {
            record: () => binding.record,
            connected: () =>
              location === "linux" ? connected(workspace) : undefined,
            acceptsInput: () =>
              binding.record.status === "running" &&
              (location === "local" || connected(workspace)),
            invoke: operation,
          });
        } else shell.record = record;
        if (
          document.activeElement === invoker ||
          document.activeElement === dialog ||
          (replacingInput && document.activeElement === document.body) ||
          (invokingSelect && document.activeElement === invokingSelect)
        )
          terminals.focus(record.id);
      } catch (cause) {
        if (revision !== intent || !dialog.open) return;
        error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        if (revision === intent) {
          loading = false;
          refresh();
        }
      }
    }

    // Claim plain Escape before xterm can consume the key.
    dialog.addEventListener(
      "keydown",
      (event) => {
        if (!isPlainEscape(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) hide(true);
      },
      true,
    );
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      hide(true);
    });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        hide(true);
    });
    current = { workspace, refresh, hide };
    document.body.append(dialog);
    staged = stageBrowserBackdrop(dialog).catch(() => hide(true));
    dialog.showModal();
    trigger.setAttribute("aria-expanded", "true");
    const present = workspace.shells[workspace.location];
    if (present) {
      body.append(present.view);
      terminals.focus(present.record.id);
    }
    void showShell();
  }

  return {
    trigger,
    toggle,
    isDialog: (dialog: Element) => dialog.classList.contains("quick-terminal"),
    reconcile() {
      trigger.disabled = !state().activeWorkspaceId;
      if (!workspaces.size) return;
      if (
        current &&
        (state().activeWorkspaceId !== current.workspace.id ||
          remoteAlias(current.workspace.id) !== current.workspace.alias)
      )
        current.hide(false);
      current?.refresh();
      const ids = new Set(state().workspaces.map(({ id }) => id));
      const alias = state().remoteWorkspace?.alias;
      for (const [id, workspace] of workspaces) {
        if (ids.has(id) || (workspace.alias && workspace.alias !== alias))
          continue;
        for (const shell of Object.values(workspace.shells)) forget(shell);
        workspaces.delete(id);
      }
    },
  };
}
