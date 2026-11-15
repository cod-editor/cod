import { dialogSurface, actionRow } from "./primitives";
import type { Invoke } from "./contracts";
import type { BrowserDownload } from "../browser/download-types";
import { actionButton, showActionError } from "./action-feedback";
export function browserDownloads(invoke: Invoke) {
  const dialog = dialogSurface("Downloads");
  dialog.className = "picker browser-library";
  dialog.setAttribute("aria-label", "Downloads");
  const heading = document.createElement("h2");
  heading.textContent = "Downloads";
  const list = document.createElement("div");
  const empty = document.createElement("p");
  empty.textContent = "No downloads";
  const rows = new Map<
    string,
    { row: HTMLElement; status: HTMLElement; actions: HTMLElement; key: string }
  >();
  let timer: ReturnType<typeof setTimeout>;
  async function refresh() {
    try {
      const entries = await invoke<BrowserDownload[]>(
        "browser.downloads",
        {},
        { reportError: false },
      );
      if (!dialog.isConnected) return;
      for (const [id, row] of rows)
        if (!entries.some((item) => item.id === id)) {
          row.row.remove();
          rows.delete(id);
        }
      for (const item of entries) {
        let view = rows.get(item.id);
        if (!view) {
          const row = document.createElement("section");
          row.className = "download-row";
          row.setAttribute("aria-label", item.basename);
          const title = document.createElement("strong");
          title.textContent = item.basename;
          const status = document.createElement("p"),
            actions = actionRow();
          row.append(title, status, actions);
          list.append(row);
          view = { row, status, actions, key: "" };
          rows.set(item.id, view);
        }
        const bytes = (value: number) => `${(value / 1024).toFixed(0)} KB`;
        view.status.textContent = `${item.status} · ${bytes(item.receivedBytes)}${item.totalBytes ? ` / ${bytes(item.totalBytes)}` : ""}`;
        const key = item.status + item.canResume;
        if (view.key === key) continue;
        view.key = key;
        const actions: Array<[string, string]> = [];
        if (item.status === "progressing")
          actions.push(["Pause", "pause"], ["Cancel", "cancel"]);
        else if (item.status === "paused")
          actions.push(["Resume", "resume"], ["Cancel", "cancel"]);
        else {
          if (item.status === "completed")
            actions.push(["Open", "open"], ["Show in folder", "reveal"]);
          else if (/^https?:/.test(item.url)) actions.push(["Retry", "retry"]);
          actions.push(["Remove from list", "remove"]);
        }
        view.actions.replaceChildren(
          ...actions.map(([label, action]) =>
            actionButton(label, async () => {
              await invoke(
                "browser.download-action",
                { id: item.id, action },
                { reportError: false },
              );
              clearTimeout(timer);
              await refresh();
            }),
          ),
        );
      }
      empty.hidden = entries.length > 0;
      list.setAttribute(
        "aria-label",
        entries.length ? "Downloaded files" : "No downloads",
      );
    } catch (error) {
      if (dialog.isConnected) showActionError(error, dialog);
    }
    if (dialog.isConnected) {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 750);
    }
  }
  dialog.append(
    heading,
    empty,
    list,
    actionRow(actionButton("Done", async () => dialog.close())),
  );
  dialog.onclose = () => {
    clearTimeout(timer);
    dialog.remove();
  };
  document.body.append(dialog);
  dialog.showModal();
  void refresh();
}
