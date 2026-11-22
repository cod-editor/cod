import { dialogSurface, actionRow } from "./primitives";
import type { Invoke } from "./contracts";
import type { Bookmark } from "../browser/library";
import { actionButton, showActionError } from "./action-feedback";
export function browserBookmarks(
  invoke: Invoke,
  open: (url: string) => Promise<void>,
  restoreFocus: () => void,
) {
  const dialog = dialogSurface("Bookmarks");
  dialog.className = "picker browser-library";
  dialog.setAttribute("aria-label", "Bookmarks");
  const input = document.createElement("input");
  input.placeholder = "Search bookmarks";
  input.setAttribute("aria-label", "Search bookmarks");
  const list = document.createElement("div");
  let revision = 0;
  async function refresh() {
    const current = ++revision;
    try {
      const entries = await invoke<Bookmark[]>(
        "browser.bookmarks",
        { query: input.value },
        { reportError: false },
      );
      if (current !== revision || !dialog.isConnected) return;
      list.replaceChildren();
      for (const entry of entries) {
        const row = document.createElement("section");
        row.className = "bookmark-row";
        const link = actionButton(entry.title, async () => {
          await open(entry.url);
          dialog.close();
        });
        link.classList.add("bookmark-link");
        link.setAttribute("aria-label", entry.title);
        link.title = entry.url;
        const title = document.createElement("span");
        title.textContent = entry.title;
        const detail = document.createElement("small");
        detail.textContent = entry.url;
        detail.id = `bookmark-address-${crypto.randomUUID()}`;
        link.setAttribute("aria-describedby", detail.id);
        link.replaceChildren(title, detail);
        const edit = actionButton("Edit", async () => {
          const form = document.createElement("form");
          const title = document.createElement("input"),
            url = document.createElement("input");
          title.value = entry.title;
          title.setAttribute("aria-label", "Bookmark name");
          url.value = entry.url;
          url.setAttribute("aria-label", "Bookmark address");
          url.required = true;
          const save = document.createElement("button");
          save.textContent = "Save";
          const cancel = actionButton("Cancel", async () => {
            await refresh();
            input.focus();
          });
          cancel.type = "button";
          form.append(title, url, save, cancel);
          form.onsubmit = async (event) => {
            event.preventDefault();
            save.disabled = true;
            try {
              await invoke(
                "browser.bookmark",
                { id: entry.id, title: title.value, url: url.value },
                { reportError: false },
              );
              await refresh();
              input.focus();
            } catch (error) {
              showActionError(error, form);
            } finally {
              save.disabled = false;
            }
          };
          form.onkeydown = (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancel.click();
            }
          };
          row.replaceChildren(form);
          title.focus();
          title.select();
        });
        const remove = actionButton("Remove", async () => {
          await invoke(
            "browser.bookmark-delete",
            { id: entry.id },
            { reportError: false },
          );
          await refresh();
          input.focus();
        });
        const actions = actionRow(edit, remove);
        actions.classList.add("bookmark-actions");
        row.append(link, actions);
        list.append(row);
      }
      if (!entries.length) {
        const empty = document.createElement("p");
        empty.textContent = "No bookmarks";
        list.append(empty);
      }
    } catch (error) {
      if (current === revision && dialog.isConnected)
        showActionError(error, dialog);
    }
  }
  input.oninput = () => void refresh();
  input.onkeydown = (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      list.querySelector("button")?.focus();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      list.querySelector("button")?.click();
    }
  };
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
