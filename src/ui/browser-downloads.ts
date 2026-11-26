import { actionRow, iconButton } from "../ui-kit";
import { actionButton } from "./action-feedback";
import {
  downloadActions,
  type DownloadAction,
  type DownloadRow,
} from "../browser/download-presentation";

const statuses: Record<DownloadRow["status"], string> = {
  progressing: "Downloading",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

function size(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index++;
  }
  return `${Number(bytes.toFixed(bytes < 10 && index ? 1 : 0))} ${units[index]}`;
}

export function createDownloadPanel(
  act: (id: string, action: DownloadAction) => Promise<unknown>,
  close: () => void,
) {
  const panel = document.createElement("section");
  panel.className = "browser-downloads-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Downloads");
  panel.tabIndex = -1;
  const header = document.createElement("header");
  const title = document.createElement("h2");
  title.textContent = "Downloads";
  const done = iconButton("close", "Close downloads", close);
  header.append(title, done);
  const list = document.createElement("div");
  list.className = "browser-downloads-list";
  list.setAttribute("aria-label", "Downloaded files");
  const empty = document.createElement("p");
  empty.className = "picker-empty";
  empty.textContent = "No downloads";
  const error = document.createElement("div");
  error.className = "action-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  panel.append(header, error, list);
  list.append(empty);
  const rows = new Map<
    string,
    {
      element: HTMLElement;
      status: HTMLParagraphElement;
      actions: HTMLElement;
      progress: HTMLProgressElement;
      key: string;
    }
  >();
  return {
    panel,
    update(entries: DownloadRow[]) {
      const ids = new Set(entries.map(({ id }) => id));
      for (const [id, view] of rows)
        if (!ids.has(id)) {
          const focused = view.element.contains(document.activeElement);
          view.element.remove();
          rows.delete(id);
          if (focused) done.focus({ preventScroll: true });
        }
      for (const [index, item] of entries.entries()) {
        let view = rows.get(item.id);
        if (!view) {
          const element = document.createElement("section");
          element.className = "download-row";
          element.setAttribute("aria-label", item.basename);
          const name = document.createElement("strong");
          name.textContent = item.basename;
          name.title = item.basename;
          const actions = actionRow();
          const status = document.createElement("p");
          const progress = document.createElement("progress");
          progress.setAttribute("aria-label", "Download progress");
          progress.max = 1;
          element.append(name, actions, status, progress);
          view = { element, status, actions, progress, key: "" };
          rows.set(item.id, view);
        }
        // Leave a retained action and its focus mounted through progress ticks.
        const current = list.children[index + 1];
        if (current !== view.element)
          list.insertBefore(view.element, current ?? null);
        const status = `${statuses[item.status]} · ${size(item.receivedBytes)}${item.totalBytes > 0 && item.status !== "completed" ? ` / ${size(item.totalBytes)}` : ""}`;
        if (view.status.textContent !== status)
          view.status.textContent = status;
        view.progress.hidden = !["progressing", "paused"].includes(item.status);
        if (item.totalBytes > 0)
          view.progress.value = Math.max(
            0,
            Math.min(1, item.receivedBytes / item.totalBytes),
          );
        else view.progress.removeAttribute("value");
        const key = item.actions.join();
        if (view.key === key) continue;
        view.key = key;
        const focused = view.actions.contains(document.activeElement);
        view.actions.replaceChildren(
          ...item.actions.map((action) => {
            const { label, short } = downloadActions[action];
            const button = actionButton(short, async () => {
              error.hidden = true;
              try {
                await act(item.id, action);
              } catch (cause) {
                error.textContent =
                  cause instanceof Error ? cause.message : String(cause);
                error.hidden = false;
              }
            });
            button.setAttribute("aria-label", label);
            button.title = label;
            return button;
          }),
        );
        if (focused)
          view.actions.querySelector("button")?.focus({ preventScroll: true });
      }
      empty.hidden = entries.length > 0;
    },
    focus() {
      done.focus({ preventScroll: true });
    },
  };
}
