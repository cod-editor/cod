import { dialogSurface, actionRow } from "./primitives";
import { formField } from "./form-field";
import type { Invoke } from "./contracts";
import { actionButton, showActionError } from "./action-feedback";
import { createSearchList } from "./search-list";
import { menu } from "./controls";
import { searchEngines, type SearchEngine } from "../browser/address";
export async function browserSettings(invoke: Invoke) {
  const settings = await invoke<{ searchEngine: SearchEngine }>(
    "browser.settings",
    {},
  );
  const dialog = dialogSurface("Browser settings");

  dialog.setAttribute("aria-label", "Browser settings");
  const title = document.createElement("h2");
  title.textContent = "Browser settings";

  const select = document.createElement("select");
  select.setAttribute("aria-label", "Search engine");
  const names = {
    google: "Google",
    duckduckgo: "DuckDuckGo",
    bing: "Bing",
    yandex: "Yandex",
  };
  select.append(...searchEngines.map((id) => new Option(names[id], id)));
  select.value = settings.searchEngine;
  select.onchange = () => {
    void invoke(
      "browser.settings",
      { searchEngine: select.value },
      { reportError: false },
    ).catch((error) => showActionError(error, dialog));
  };
  const label = formField("Search engine", select);
  dialog.append(
    title,
    label,
    actionRow(actionButton("Done", async () => dialog.close())),
  );
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
  select.focus();
}
export function browserHistory(
  invoke: Invoke,
  open: (url: string) => Promise<void>,
) {
  const dialog = document.createElement("dialog");
  dialog.className = "picker browser-library";
  dialog.setAttribute("aria-label", "Browsing history");
  const input = document.createElement("input");
  input.placeholder = "Search history";
  input.setAttribute("aria-label", "Search history");
  const list = document.createElement("div");
  list.className = "command-list";
  const selection = createSearchList(input, list);
  let revision = 0;
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
    try {
      const entries = await invoke<
        Array<{ url: string; title: string; visitedAt: number }>
      >(
        "browser.history",
        { query: input.value, limit: 100 },
        { reportError: false },
      );
      if (request !== revision || !dialog.isConnected) return;
      list.replaceChildren();
      for (const entry of entries) {
        const button = actionButton(entry.title, async () => {
          await open(entry.url);
          dialog.close();
        });
        const detail = document.createElement("small");
        detail.textContent = entry.url;
        button.append(detail);
        button.title = new Date(entry.visitedAt).toLocaleString();
        button.oncontextmenu = (event) => {
          event.preventDefault();
          menu({ x: event.clientX, y: event.clientY }, [
            {
              label: "Remove from history",
              run: () => {
                void remove(entry.url).catch((error) =>
                  showActionError(error, dialog),
                );
              },
            },
          ]);
        };
        button.onkeydown = (event) => {
          if (event.key === "Delete") {
            event.preventDefault();
            void remove(entry.url).catch((error) =>
              showActionError(error, dialog),
            );
          }
        };
        list.append(button);
      }
      if (!entries.length) {
        const empty = document.createElement("p");
        empty.textContent = "No history matches";
        list.append(empty);
      }
      selection.update();
    } catch (error) {
      if (request === revision) showActionError(error, dialog);
    }
  }
  input.oninput = () => void refresh();
  dialog.append(
    input,
    list,
    actionButton("Clear history", () => remove()),
    actionRow(actionButton("Done", async () => dialog.close())),
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
