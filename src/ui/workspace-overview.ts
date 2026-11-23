import type { AppState } from "../types";
import type { Invoke } from "./contracts";
import type { createFocusManager } from "./focus";
import type { createWorkspaceNavigation } from "./workspace-navigation";
import {
  visibleNavigation,
  describeNavigationStatus,
  type NavigationItem,
} from "./navigation-model";
import { createSearchList } from "./search-list";
import {
  dialogSurface,
  shortcutHint,
  uiButton,
  icon,
  iconButton,
} from "../ui-kit";
import { confirmAction } from "./dialogs";
import { menu } from "./controls";
import { commands, formatBinding, resolveKeybinding } from "../keyboard";
import { keyboardPlatform } from "./keyboard-ui";
import { showActionError } from "./action-feedback";
import { conversationRemovalReason } from "../conversation-actions";

// Leave retained rows attached so a background update cannot cancel a pressed action.
function syncChildren(parent: HTMLElement, ordered: HTMLElement[]): void {
  const retained = new Set(ordered);
  for (const child of [...parent.children]) {
    if (!retained.has(child as HTMLElement)) child.remove();
  }
  let current = parent.firstElementChild;
  for (const child of ordered) {
    if (child !== current) parent.insertBefore(child, current);
    current = child.nextElementSibling;
  }
}

export function createWorkspaceOverview(
  getState: () => AppState,
  invoke: Invoke,
  navigation: Pick<
    ReturnType<typeof createWorkspaceNavigation>,
    "items" | "actions" | "close"
  >,
  focus: ReturnType<typeof createFocusManager>,
  activate: (item: NavigationItem, newShell?: boolean) => Promise<void>,
  destinations: {
    newConversation: (workspace: string) => Promise<void>;
    openPane: (workspace: string, pane: string) => Promise<void>;
    fallback: () => Promise<void>;
    stageBrowserBackdrop: (dialog: HTMLDialogElement) => Promise<void>;
  },
) {
  let current:
    | {
        dialog: HTMLDialogElement;
        refresh: () => void;
        cancel: () => void;
        rename: (key: string) => void;
        closeFromSearch: () => void;
      }
    | undefined;
  function toggle(renameKey?: string, showClosed = false): void {
    if (current && !current.dialog.open) {
      current.dialog.remove();
      current = undefined;
    }
    if (current) {
      if (renameKey) {
        current.rename(renameKey);
        return;
      }
      if (
        [...document.querySelectorAll("dialog[open]")].at(-1) === current.dialog
      )
        current.cancel();
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    const origin = focus.capture();
    const dialog = dialogSurface("Overview");
    dialog.className = "picker search-picker picker-wide workspace-overview";
    dialog.dataset.browserBackdrop = "overview";
    const input = document.createElement("input");
    input.placeholder = "Search Overview…";
    input.setAttribute("aria-label", "Search Overview");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-haspopup", "grid");
    input.setAttribute("aria-autocomplete", "list");
    const header = document.createElement("header");
    header.className = "picker-search";
    const includeClosed = uiButton("Show closed", "quiet", icon("archive"));
    includeClosed.classList.add("toggle");
    includeClosed.title = "Show closed workspaces and cancelled reviews";
    includeClosed.setAttribute(
      "aria-label",
      "Show closed workspaces and cancelled reviews",
    );
    includeClosed.setAttribute("aria-pressed", String(showClosed));
    header.append(input, includeClosed);
    const list = document.createElement("div");
    list.className = "command-list overview-list";
    list.setAttribute("role", "grid");
    list.setAttribute("aria-label", "Workspace Overview");
    const empty = document.createElement("p");
    empty.className = "settings-note";
    empty.setAttribute("role", "status");
    const footer = document.createElement("footer");
    footer.className = "picker-footer";
    dialog.append(header, list, empty, footer);
    const renameBinding = formatBinding(
      { code: "Enter", mod: true, surfaces: ["shell"] },
      keyboardPlatform,
    );
    const navigationItems = () => navigation.items(showClosed);
    let items = navigationItems();
    const active = items.find((item) => item.active);
    let selectedKey = active?.key;
    let retainedKey: string | undefined;
    let queryVersion = 0;
    let visible: NavigationItem[] = [];
    let signature = "";
    const groupCache = new Map<string, HTMLElement>();
    const rowCache = new Map<string, { signature: string; row: HTMLElement }>();
    let actionControl: HTMLButtonElement | undefined;
    let highlighted: HTMLButtonElement | undefined;
    let unfilteredScroll = 0;
    let wasSearching = false;
    let performed = false;
    let cancelled = false;
    let closing = false;
    let hintSignature = "";
    let edit: { key: string; value: string; saving: boolean } | undefined;
    const selection = createSearchList(input, list, {
      selector: "button.overview-item:not([hidden])",
      wrapNavigation: false,
      onSelect: (row) => {
        highlighted?.setAttribute("aria-selected", "false");
        highlighted?.parentElement?.setAttribute("aria-selected", "false");
        highlighted = row;
        highlighted?.setAttribute("aria-selected", "true");
        highlighted?.parentElement?.setAttribute("aria-selected", "true");
        if (row) selectedKey = row.dataset.navigationKey;
        if (actionControl) actionControl.tabIndex = -1;
        actionControl =
          row?.parentElement?.querySelector<HTMLButtonElement>(
            ".overview-actions",
          ) ?? undefined;
        if (actionControl) actionControl.tabIndex = 0;
        updateHints();
      },
    });
    const find = (key = selectedKey) => items.find((item) => item.key === key);
    function highlight(key: string | undefined, scroll = false) {
      const row = [
        ...list.querySelectorAll<HTMLButtonElement>(".overview-item"),
      ].find((row) => row.dataset.navigationKey === key);
      selection.select(row, scroll);
    }
    function open(item: NavigationItem) {
      const latest = navigationItems().find((row) => row.key === item.key);
      if (!latest) {
        if (item.closed)
          showActionError("This workspace is no longer closed", dialog);
        return;
      }
      if (
        latest.closed &&
        getState().closedWorkspaces?.find(
          ({ workspace }) => workspace.id === latest.id,
        )?.terminals.length
      ) {
        const confirmation = confirmAction(
          "Reopen workspace?",
          `Reopen ${latest.label} with new shells? Previous terminal processes have ended. Commands will not be replayed.`,
          "Reopen workspace",
          async () => {
            confirmation.close();
            perform(() => activate(latest, true));
          },
        );
      } else perform(() => activate(latest));
    }
    function perform(task: () => Promise<void>) {
      if (performed) return;
      performed = true;
      // Keep modal-close restoration from racing the explicit navigation intent.
      dialog.close();
      document.querySelector<HTMLElement>("#workspace-selector")?.focus();
      void task().catch((error) => {
        // A failed operation must retain the query and exact selected object.
        performed = false;
        if (document.querySelector("dialog[open]")) return;
        document.body.append(dialog);
        current = {
          dialog,
          refresh,
          cancel,
          rename: renameSelected,
          closeFromSearch,
        };
        dialog.showModal();
        document
          .querySelector("#workspace-selector")
          ?.setAttribute("aria-expanded", "true");
        showActionError(error, dialog);
        input.focus();
        refresh();
      });
    }
    function endEdit(restore: boolean) {
      edit = undefined;
      signature = "";
      refresh();
      if (restore) input.focus();
    }
    async function saveEdit(restore: boolean) {
      const pending = edit;
      const item = pending && find(pending.key);
      if (!pending || !item || pending.saving) return;
      const name = pending.value.trim();
      if (!name) {
        endEdit(restore);
        return;
      }
      const version = queryVersion;
      pending.saving = true;
      dialog.querySelector(".action-error")?.remove();
      dialog.querySelector(".overview-name")?.removeAttribute("aria-invalid");
      try {
        await invoke(
          item.kind === "workspace"
            ? "workspace.rename"
            : "conversation.rename",
          { id: item.id, name },
        );
        if (edit === pending) {
          if (version === queryVersion) retainedKey = pending.key;
          endEdit(restore);
        }
      } catch (error) {
        pending.saving = false;
        showActionError(error, dialog);
        dialog
          .querySelector<HTMLInputElement>(".overview-name")
          ?.setAttribute("aria-invalid", "true");
      }
    }
    function rename(item: NavigationItem) {
      selectedKey = item.key;
      edit = { key: item.key, value: item.label, saving: false };
      signature = "";
      refresh();
      const editor = dialog.querySelector<HTMLInputElement>(".overview-name");
      editor?.focus();
      editor?.select();
    }
    function renameSelected(key: string) {
      const item = find(key);
      if (
        item &&
        !item.closed &&
        (item.kind === "workspace" || item.kind === "conversation")
      )
        rename(item);
    }
    function updateHints() {
      const selected = find();
      const hints: [string, string][] = [];
      if (document.activeElement === input && selected && !edit) {
        hints.push([selected.closed ? "Reopen" : "Open", "Enter"]);
        if (
          !selected.closed &&
          (selected.kind === "workspace" || selected.kind === "conversation")
        )
          hints.push(["Rename", renameBinding]);
        const action = closeAction(selected);
        if (action) {
          const close = commands
            .find((command) => command.id === "tab.close")
            ?.bindings.filter(
              (binding) =>
                (!binding.platform || binding.platform === keyboardPlatform) &&
                binding.surfaces.includes("shell"),
            )
            .map((binding) => formatBinding(binding, keyboardPlatform))
            .find((shortcut) => shortcut !== renameBinding);
          if (close) hints.push([action, close]);
        }
      } else if (document.activeElement === input && !selected && !edit) {
        hints.push(["Close Overview", "Esc"]);
      } else if (
        edit &&
        document.activeElement?.classList.contains("overview-name")
      ) {
        hints.push(["Save", "Enter"], ["Cancel rename", "Esc"]);
      }
      const signature = JSON.stringify(hints);
      if (hintSignature === signature) return;
      hintSignature = signature;
      footer.hidden = !hints.length;
      footer.replaceChildren(
        ...hints.map(([label, keys]) => {
          const item = document.createElement("span");
          item.append(label, shortcutHint(keys));
          return item;
        }),
      );
    }
    function closeAction(item: NavigationItem | undefined) {
      if (!item || item.closed) return;
      if (item.kind === "workspace") return "Close workspace";
      const state = getState();
      const pane = state.workspaces
        .find((workspace) => workspace.id === item.workspaceId)
        ?.panes.find((pane) => pane.id === item.paneId);
      if (pane) return pane.pinned ? undefined : "Close tab";
      if (item.kind !== "conversation") return;
      const conversation = state.conversations.find(
        (chat) => chat.id === item.id,
      );
      if (conversation && !conversationRemovalReason(state, conversation))
        return "Remove from workspace";
    }
    async function closeSelected() {
      const item = find();
      const action = closeAction(item);
      if (!item || !action || closing) return;
      closing = true;
      dialog.querySelector(".action-error")?.remove();
      try {
        if (action === "Remove from workspace")
          await invoke("conversation.remove", { id: item.id });
        else await navigation.close(item);
        refresh();
      } catch (error) {
        showActionError(error, dialog);
      } finally {
        closing = false;
      }
    }
    function closeFromSearch() {
      if (document.activeElement === input && !edit) void closeSelected();
    }
    function actions(
      item: NavigationItem,
      anchor: HTMLElement | { x: number; y: number },
    ) {
      const invoker =
        anchor instanceof HTMLElement && document.activeElement === anchor
          ? anchor
          : input;
      selectedKey = item.key;
      highlight(item.key);
      input.focus();
      menu(
        anchor,
        navigation
          .actions(item, {
            rename,
            open,
            restoreFocus: () => {
              if (
                dialog.open &&
                [...document.querySelectorAll("dialog[open]")].at(-1) === dialog
              )
                input.focus();
            },
            newConversation: (workspace) =>
              perform(() => destinations.newConversation(workspace)),
            openPane: (workspace, pane) =>
              perform(() => destinations.openPane(workspace, pane)),
          })
          .map((action) =>
            action?.command === "conversation.move"
              ? {
                  ...action,
                  run: () => {
                    retainedKey = item.key;
                    action.run();
                  },
                }
              : action,
          ),
        {
          showCommands: false,
          restoreFocus: () => {
            if (
              [...document.querySelectorAll("dialog[open]")].at(-1) !== dialog
            )
              return;
            (invoker.isConnected ? invoker : input).focus({
              preventScroll: true,
            });
          },
        },
      );
    }
    function fallbackSelection(
      previous: NavigationItem[],
      next: NavigationItem[],
      key: string | undefined,
    ): string | undefined {
      const index = previous.findIndex((row) => row.key === key);
      if (index < 0) return next[0]?.key;
      const removed = previous[index];
      const keys = new Set(next.map((row) => row.key));
      const neighbors = [
        ...previous.slice(index + 1),
        ...previous.slice(0, index).reverse(),
      ].filter((row) => keys.has(row.key));
      return (
        neighbors.find((row) => row.parent && row.parent === removed.parent) ??
        next.find(
          (row) =>
            row.kind === "workspace" && row.workspaceId === removed.workspaceId,
        ) ??
        neighbors[0] ??
        next[0]
      )?.key;
    }
    function refresh() {
      if (!dialog.open) return;
      items = navigationItems();
      if (
        edit &&
        list.querySelector(".overview-name") === document.activeElement
      ) {
        if (items.some((item) => item.key === edit?.key)) {
          for (const row of list.querySelectorAll<HTMLElement>(
            ".overview-row",
          )) {
            const item = items.find(
              (item) => item.key === row.dataset.navigationKey,
            );
            if (item) row.dataset.status = item.status;
          }
          return;
        }
        edit = undefined;
      }
      const previous = visible;
      const query = input.value;
      visible = visibleNavigation(items, query, retainedKey);
      const remote = getState().remoteWorkspace;
      const nextSignature = JSON.stringify([
        visible,
        !!query.trim(),
        edit?.key,
        remote,
      ]);
      if (nextSignature === signature) {
        updateHints();
        return;
      }
      signature = nextSignature;
      if (!visible.some((row) => row.key === selectedKey))
        selectedKey = fallbackSelection(previous, visible, selectedKey);
      const top = list.scrollTop;
      const editing =
        edit && list.querySelector<HTMLInputElement>(".overview-name");
      const groups = new Map<
        string,
        { element: HTMLElement; rows: HTMLElement[] }
      >();
      for (const item of visible) {
        if (item.kind !== "workspace") continue;
        let element = groupCache.get(item.workspaceId);
        if (!element) {
          element = document.createElement("div");
          element.className = "overview-group";
          element.setAttribute("role", "rowgroup");
          groupCache.set(item.workspaceId, element);
        }
        if (element.getAttribute("aria-label") !== item.label)
          element.setAttribute("aria-label", item.label);
        groups.set(item.workspaceId, { element, rows: [] });
      }
      for (const id of groupCache.keys())
        if (!groups.has(id)) groupCache.delete(id);
      const surviving = new Set(items.map((item) => item.key));
      for (const key of rowCache.keys())
        if (!surviving.has(key)) rowCache.delete(key);
      for (const item of visible) {
        const host =
          item.kind === "workspace" && remote?.ids.includes(item.workspaceId)
            ? remote.alias + (remote.connected ? "" : ", disconnected")
            : undefined;
        const rowSignature = JSON.stringify([
          item,
          edit?.key === item.key,
          host,
        ]);
        const cached = rowCache.get(item.key);
        if (cached?.signature === rowSignature) {
          groups.get(item.workspaceId)?.rows.push(cached.row);
          continue;
        }

        const row = document.createElement("div");
        row.className = "overview-row ui-picker-row";
        row.dataset.status = item.status;
        row.dataset.kind = item.kind;
        row.dataset.navigationKey = item.key;
        row.toggleAttribute("data-closed", !!item.closed);
        row.setAttribute("role", "row");
        row.setAttribute("aria-selected", "false");
        row.style.setProperty(
          "--overview-indent",
          item.kind === "workspace" ? "0px" : "var(--space-4)",
        );
        const leading = icon(item.kind);
        leading.classList.add("navigation-item-icon");
        const button = uiButton("", "quiet", leading);
        button.classList.add("overview-item", "ui-picker-row-main");
        button.dataset.navigationKey = item.key;
        button.setAttribute("role", "gridcell");
        button.setAttribute("aria-selected", "false");
        button.dataset.active = String(item.active);
        const description = [
          item.closed ? "Closed workspace" : "",
          item.active ? "Currently open" : "",
          item.hint ?? "",
        ]
          .filter(Boolean)
          .join(". ");
        if (description) button.setAttribute("aria-description", description);
        if (item.hint) button.title = item.hint;
        button.setAttribute(
          "aria-label",
          `${item.label}${item.kind === "browser" || item.closed ? "" : ", " + describeNavigationStatus(item.status, item.context)}${item.pinned ? ", Pinned" : ""}${host ? ", " + host : ""}`,
        );
        button.onclick = () => open(item);
        const label = document.createElement("span");
        label.className = "overview-label";
        label.textContent =
          item.kind === "browser" ? item.label.slice(0, 160) : item.label;
        if (host) label.textContent += " (" + host + ")";
        button.append(label);
        if (item.pinned) button.append(icon("pin"));
        row.append(button);
        if (edit?.key === item.key) {
          const editor = editing || document.createElement("input");
          editor.className = "overview-name";
          editor.setAttribute(
            "aria-label",
            item.kind === "workspace" ? "Workspace name" : "Conversation name",
          );
          editor.maxLength = 255;
          if (!editing) editor.value = edit.value;
          editor.oninput = () => {
            if (edit) edit.value = editor.value;
          };
          editor.onkeydown = (event) => {
            event.stopPropagation();
            if (event.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              void saveEdit(true);
            }
            if (event.key === "Escape") {
              event.preventDefault();
              endEdit(true);
            }
          };
          editor.onblur = () => {
            if (edit?.key === item.key) void saveEdit(false);
          };
          // Editable content is a sibling cell, not an input nested in a button.
          button.hidden = true;
          button.classList.add("selected");
          row.setAttribute("aria-selected", "true");
          const cell = document.createElement("div");
          cell.className = "overview-edit-cell";
          cell.setAttribute("role", "gridcell");
          cell.append(editor);
          row.append(cell);
        }
        const more = iconButton("more", `Actions for ${item.label}`, () =>
          actions(item, more),
        );
        more.classList.add("embedded", "overview-actions");
        more.setAttribute("role", "gridcell");
        more.setAttribute("aria-haspopup", "dialog");
        more.tabIndex = -1;
        row.append(more);
        row.oncontextmenu = (event) => {
          event.preventDefault();
          actions(item, { x: event.clientX, y: event.clientY });
        };
        rowCache.set(item.key, { signature: rowSignature, row });
        groups.get(item.workspaceId)?.rows.push(row);
      }
      for (const { element, rows } of groups.values())
        syncChildren(element, rows);
      syncChildren(
        list,
        [...groups.values()].map(({ element }) => element),
      );
      list.scrollTop = top;
      const preferred = [
        ...list.querySelectorAll<HTMLButtonElement>(".overview-item"),
      ].find((row) => row.dataset.navigationKey === selectedKey);
      if (edit && visible.some((item) => item.key === edit?.key)) {
        selection.select(undefined);
        input.removeAttribute("aria-activedescendant");
        const editingActions = list.querySelector<HTMLButtonElement>(
          `[data-navigation-key="${edit.key}"] .overview-actions`,
        );
        if (editingActions) editingActions.tabIndex = 0;
      } else selection.update(preferred);
      list.hidden = !visible.length;
      input.setAttribute("aria-expanded", String(!!visible.length));
      empty.textContent = items.length ? "No matching items" : "No workspaces";
      empty.hidden = !!visible.length;
      updateHints();
    }
    dialog.addEventListener("focusin", updateHints);
    includeClosed.addEventListener("click", () => {
      showClosed = !showClosed;
      includeClosed.setAttribute("aria-pressed", String(showClosed));
      refresh();
    });
    input.addEventListener("input", () => {
      queryVersion++;
      retainedKey = undefined;
      const searching = !!input.value.trim();
      if (searching && !wasSearching) unfilteredScroll = list.scrollTop;
      refresh();
      if (searching) highlight(selectedKey, true);
      else if (wasSearching) list.scrollTop = unfilteredScroll;
      wasSearching = searching;
    });
    dialog.addEventListener(
      "keydown",
      (event) => {
        if (
          event.isComposing ||
          event.keyCode === 229 ||
          event.getModifierState("AltGraph")
        )
          return;
        const searchFocused = event.target === input && !edit;
        const modifiedEnter =
          event.key === "Enter" &&
          (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey);
        const renameChord =
          modifiedEnter &&
          !event.shiftKey &&
          !event.altKey &&
          event.ctrlKey === (keyboardPlatform === "linux") &&
          event.metaKey === (keyboardPlatform === "darwin");
        const match = resolveKeybinding(event, keyboardPlatform, "shell");
        if (!(
          match?.command === "tab.close" ||
          (searchFocused && modifiedEnter)
        ))
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!searchFocused || event.repeat) return;
        if (renameChord && selectedKey) renameSelected(selectedKey);
        else if (match?.command === "tab.close" && match.dispatch)
          closeFromSearch();
      },
      true,
    );
    dialog.addEventListener("keydown", (event) => {
      if (event.isComposing || edit) return;
      const item = find();
      if (
        event.key === "ContextMenu" ||
        (event.shiftKey && event.key === "F10")
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (item) actions(item, selection.selected() ?? input);
      }
    });
    function restoreOrigin() {
      const workspace = getState().workspaces.find(
        (w) => w.id === getState().activeWorkspaceId,
      );
      const pane = workspace?.panes.find(
        (p) => p.id === workspace.activePaneId,
      );
      const valid = origin.browserId
        ? pane?.kind === "browser" &&
          pane.browserId === origin.browserId &&
          !getState().browsers.find((b) => b.id === origin.browserId)?.error
        : !origin.paneId || pane?.id === origin.paneId;
      if (valid && focus.restore(origin)) return;
      document.querySelector<HTMLElement>("#workspace-selector")?.focus();
      void destinations.fallback();
    }
    function cancel() {
      if (!dialog.open) return;
      cancelled = true;
      dialog.close();
      restoreOrigin();
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancel();
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
        cancel();
    });
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      dialog.remove();
      if (current?.dialog === dialog) current = undefined;
      document
        .querySelector("#workspace-selector")
        ?.setAttribute("aria-expanded", String(!!current?.dialog.open));
      if (
        !performed &&
        !cancelled &&
        !document.querySelector("dialog[open]") &&
        (document.activeElement === document.body ||
          document.activeElement === origin.element)
      )
        restoreOrigin();
    });
    document.body.append(dialog);
    current = {
      dialog,
      refresh,
      cancel,
      rename: renameSelected,
      closeFromSearch,
    };
    void destinations.stageBrowserBackdrop(dialog).catch(cancel);
    dialog.showModal();
    document
      .querySelector("#workspace-selector")
      ?.setAttribute("aria-expanded", "true");
    refresh();
    input.focus();
    highlight(selectedKey, true);
    if (renameKey) renameSelected(renameKey);
  }
  return {
    toggle: () => toggle(),
    openClosed: () => toggle(undefined, true),
    rename: (key: string) => toggle(key),
    refresh: () => current?.refresh(),
    handleCloseShortcut: () => {
      if (
        !current?.dialog.open ||
        [...document.querySelectorAll("dialog[open]")].at(-1) !== current.dialog
      )
        return false;
      current.closeFromSearch();
      return true;
    },
    isOpen: () => !!current,
    dispose: () => {
      current?.dialog.remove();
      current = undefined;
      document
        .querySelector("#workspace-selector")
        ?.setAttribute("aria-expanded", "false");
    },
  };
}
