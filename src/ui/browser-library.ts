import { actionRow } from "./primitives";
import type { Invoke } from "./contracts";
import { actionButton, showActionError } from "./action-feedback";
import { createSearchList } from "./search-list";
import { iconButton, menu } from "./controls";
export function browserHistory(
  invoke: Invoke,
  open: (url: string) => Promise<void>,
  restoreFocus: () => void,
) {
  const dialog = document.createElement("dialog");
  dialog.className = "picker browser-library";
  dialog.setAttribute("aria-label", "Browsing history");
  const input = document.createElement("input");
  input.className = "browser-history-query";
  input.placeholder = "Search history";
  input.setAttribute("aria-label", "Search history");
  const list = document.createElement("div");
  list.className = "command-list";
  let actionControl: HTMLButtonElement | undefined;
  const selection = createSearchList(input, list, {
    selector: ".browser-history-link:not(:disabled)",
    onSelect: (row) => {
      if (actionControl) actionControl.tabIndex = -1;
      actionControl =
        row?.parentElement?.querySelector<HTMLButtonElement>(
          ".browser-history-actions",
        ) ?? undefined;
      if (actionControl) actionControl.tabIndex = 0;
    },
  });
  let revision = 0;
  let displayedQuery: string | undefined;
  async function remove(url?: string) {
    await invoke(
      url ? "browser.history-delete" : "browser.history-clear",
      url ? { url } : {},
      { reportError: false },
    );
    await refresh();
  }
  async function refresh() {
    const request = ++revision;
    const query = input.value;
    try {
      const entries = await invoke<
        Array<{ url: string; title: string; visitedAt: number }>
      >("browser.history", { query, limit: 100 }, { reportError: false });
      if (request !== revision || !dialog.isConnected) return;
      const previous = selection.selected();
      const previousIndex =
        previous && displayedQuery === query
          ? [...list.children].indexOf(previous.parentElement!)
          : 0;
      const previousUrl =
        displayedQuery === query ? previous?.dataset.url : undefined;
      displayedQuery = query;
      const links: HTMLButtonElement[] = [];
      list.replaceChildren();
      for (const entry of entries) {
        const row = document.createElement("div");
        row.className = "ui-picker-row browser-history-row";
        const button = actionButton(entry.title, async () => {
          await open(entry.url);
          dialog.close();
        });
        button.classList.add("browser-history-link", "ui-picker-row-main");
        button.dataset.url = entry.url;
        button.setAttribute("aria-label", entry.title);
        const title = document.createElement("span");
        title.textContent = entry.title;
        const detail = document.createElement("small");
        detail.textContent = entry.url;
        detail.id = `history-address-${crypto.randomUUID()}`;
        button.setAttribute("aria-describedby", detail.id);
        button.replaceChildren(title, detail);
        button.title = new Date(entry.visitedAt).toLocaleString();
        const showActions = (
          anchor: HTMLElement | { x: number; y: number },
        ) => {
          if (displayedQuery !== input.value) return;
          selection.select(button);
          menu(anchor, [
            {
              label: "Remove from history",
              run: () => {
                input.focus({ preventScroll: true });
                void remove(entry.url).catch((error) =>
                  showActionError(error, dialog),
                );
              },
            },
          ]);
        };
        const more = iconButton("more", `Actions for ${entry.title}`, () =>
          showActions(more),
        );
        more.classList.add("embedded", "browser-history-actions");
        more.setAttribute("aria-haspopup", "dialog");
        more.tabIndex = -1;
        row.oncontextmenu = (event) => {
          event.preventDefault();
          showActions({ x: event.clientX, y: event.clientY });
        };
        row.append(button, more);
        links.push(button);
        list.append(row);
      }
      if (!entries.length) {
        const empty = document.createElement("p");
        empty.textContent = "No history matches";
        list.append(empty);
      }
      selection.update(
        links.find((button) => button.dataset.url === previousUrl) ??
          links[Math.min(previousIndex, links.length - 1)],
      );
    } catch (error) {
      if (request === revision) showActionError(error, dialog);
    }
  }
  input.oninput = () => void refresh();
  input.addEventListener("keydown", (event) => {
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.getModifierState("AltGraph") ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
    )
      return;
    event.preventDefault();
    if (!event.repeat) actionControl?.click();
  });
  const close = () => {
    dialog.close();
    restoreFocus();
  };
  dialog.oncancel = (event) => {
    event.preventDefault();
    close();
  };
  dialog.append(
    input,
    list,
    actionButton("Clear history", () => remove()),
    actionRow(actionButton("Done", async () => close())),
  );
  dialog.onclose = () => {
    revision++;
    dialog.remove();
  };
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
  void refresh();
}
