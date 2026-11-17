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
import { dialogSurface, uiButton } from "./primitives";
import { icon, iconButton, menu } from "./controls";
import { showActionError } from "./action-feedback";

export function createWorkspaceOverview(
  getState: () => AppState,
  invoke: Invoke,
  navigation: Pick<
    ReturnType<typeof createWorkspaceNavigation>,
    "items" | "actions"
  >,
  focus: ReturnType<typeof createFocusManager>,
  activate: (item: NavigationItem) => Promise<void>,
  destinations: {
    newConversation: (workspace: string) => Promise<void>;
    openPane: (workspace: string, pane: string) => Promise<void>;
    fallback: () => Promise<void>;
  },
) {
  let current:
    | { dialog: HTMLDialogElement; refresh: () => void; cancel: () => void }
    | undefined;
  function toggle(): void {
    if (current && !current.dialog.open) {
      current.dialog.remove();
      current = undefined;
    }
    if (current) {
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
    const input = document.createElement("input");
    input.placeholder = "Search workspaces, chats, pages and terminals...";
    input.setAttribute("aria-label", "Search Overview");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-haspopup", "grid");
    input.setAttribute("aria-autocomplete", "list");
    const list = document.createElement("div");
    list.className = "command-list overview-list";
    list.setAttribute("role", "grid");
    list.setAttribute("aria-label", "Workspace Overview");
    const empty = document.createElement("p");
    empty.className = "settings-note";
    empty.setAttribute("role", "status");
    dialog.append(input, list, empty);
    let items = navigation.items("overview");
    const active = items.find((item) => item.active);
    let selectedKey = active?.key;
    let retainedKey: string | undefined;
    let queryVersion = 0;
    let visible: NavigationItem[] = [];
    let signature = "";
    const rowCache = new Map<string, { signature: string; row: HTMLElement }>();
    let actionControl: HTMLButtonElement | undefined;
    let highlighted: HTMLButtonElement | undefined;
    let unfilteredScroll = 0;
    let wasSearching = false;
    let performed = false;
    let cancelled = false;
    let edit: { key: string; value: string; saving: boolean } | undefined;
    const selection = createSearchList(input, list, {
      selector: "button.overview-item:not([hidden])",
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
      const latest = navigation
        .items("overview")
        .find((row) => row.key === item.key);
      if (latest) perform(() => activate(latest));
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
        current = { dialog, refresh, cancel };
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
    function actions(
      item: NavigationItem,
      anchor: HTMLElement | { x: number; y: number },
    ) {
      selectedKey = item.key;
      highlight(item.key);
      input.focus();
      menu(
        anchor,
        navigation
          .actions(item, {
            rename,
            open,
            restoreTree: false,
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
      );
    }
    function refresh() {
      if (!dialog.open) return;
      items = navigation.items("overview");
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
      visible = visibleNavigation(items, query, new Set(), retainedKey);
      const nextSignature = JSON.stringify([
        visible,
        !!query.trim(),
        edit?.key,
      ]);
      if (nextSignature === signature) return;
      signature = nextSignature;
      if (!visible.some((row) => row.key === selectedKey)) {
        const index = previous.findIndex((row) => row.key === selectedKey);
        selectedKey =
          [
            ...previous.slice(index + 1),
            ...previous.slice(0, index).reverse(),
          ].find((row) => visible.some((next) => next.key === row.key))?.key ??
          visible[0]?.key;
      }
      const top = list.scrollTop;
      const editing =
        edit && list.querySelector<HTMLInputElement>(".overview-name");
      const fragment = document.createDocumentFragment();
      const groups = new Map<string, HTMLElement>();
      for (const item of visible) {
        if (item.kind !== "workspace") continue;
        const group = document.createElement("div");
        group.className = "overview-group";
        group.setAttribute("role", "rowgroup");
        group.setAttribute("aria-label", item.label);
        groups.set(item.workspaceId, group);
        fragment.append(group);
      }
      const surviving = new Set(items.map((item) => item.key));
      for (const key of rowCache.keys())
        if (!surviving.has(key)) rowCache.delete(key);
      for (const item of visible) {
        const rowSignature = JSON.stringify([item, edit?.key === item.key]);
        const cached = rowCache.get(item.key);
        if (cached?.signature === rowSignature) {
          groups.get(item.workspaceId)?.append(cached.row);
          continue;
        }

        const row = document.createElement("div");
        row.className = "overview-row workspace-row ui-picker-row";
        row.dataset.status = item.status;
        row.dataset.kind = item.kind;
        row.dataset.navigationKey = item.key;
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
          item.active ? "Currently open" : "",
          item.hint ?? "",
        ]
          .filter(Boolean)
          .join(". ");
        if (description) button.setAttribute("aria-description", description);
        if (item.hint) button.title = item.hint;
        button.setAttribute(
          "aria-label",
          `${item.label}${item.kind === "browser" ? "" : ", " + describeNavigationStatus(item.status, item.context)}${item.pinned ? ", Pinned" : ""}`,
        );
        button.onclick = () => open(item);
        const label = document.createElement("span");
        label.className = "overview-label";
        label.textContent = item.label;
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
        more.classList.add("overview-actions");
        more.setAttribute("role", "gridcell");
        more.setAttribute("aria-haspopup", "menu");
        more.tabIndex = -1;
        row.append(more);
        row.oncontextmenu = (event) => {
          event.preventDefault();
          actions(item, { x: event.clientX, y: event.clientY });
        };
        rowCache.set(item.key, { signature: rowSignature, row });
        groups.get(item.workspaceId)?.append(row);
      }
      list.replaceChildren(fragment);
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
    }
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
    current = { dialog, refresh, cancel };
    dialog.showModal();
    document
      .querySelector("#workspace-selector")
      ?.setAttribute("aria-expanded", "true");
    refresh();
    input.focus();
    highlight(selectedKey, true);
  }
  return {
    toggle,
    refresh: () => current?.refresh(),
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
