import { ipcRenderer } from "electron";
import { suggestionRow } from "../ui/browser-suggestion-list";
import type { SuggestionPaint } from "./address-suggestion-types";
import type { DownloadPopup, DownloadRow } from "./download-presentation";
import { createDownloadPanel } from "../ui/browser-downloads";

window.addEventListener("DOMContentLoaded", () => {
  const list = document.querySelector<HTMLElement>(".browser-suggestions")!;
  let downloadRevision: number | undefined;
  const close = () =>
    ipcRenderer.send("cod:download-overlay-close", downloadRevision);
  const downloads = createDownloadPanel(
    (id, action) =>
      ipcRenderer.invoke(
        "cod:download-overlay-action",
        downloadRevision,
        id,
        action,
      ),
    close,
  );
  downloads.panel.hidden = true;
  document.body.append(downloads.panel);
  // Match the actual border box so clicks below a short list reach the page.
  const reportSize = () => {
    const height = Math.ceil(downloads.panel.getBoundingClientRect().height);
    if (downloadRevision !== undefined && height > 0)
      ipcRenderer.send("cod:download-overlay-size", downloadRevision, height);
  };
  new ResizeObserver(reportSize).observe(downloads.panel);
  document.addEventListener("keydown", (event) => {
    if (
      downloadRevision !== undefined &&
      event.key === "Escape" &&
      !event.isComposing
    ) {
      event.preventDefault();
      close();
    }
  });
  ipcRenderer.on(
    "cod:download-overlay-paint",
    (
      _event,
      { popup, entries }: { popup: DownloadPopup; entries: DownloadRow[] },
    ) => {
      const opening = popup.revision !== downloadRevision;
      downloadRevision = popup.revision;
      document.body.removeAttribute("aria-hidden");
      document.body.className = "browser-downloads-native";
      document.documentElement.style.setProperty(
        "--ui-font-size",
        popup.fontSize,
      );
      document.documentElement.style.setProperty(
        "--ui-font-family",
        popup.fontFamily,
      );
      list.hidden = true;
      downloads.panel.hidden = false;
      downloads.panel.style.maxHeight = `${popup.bounds.height}px`;
      downloads.update(entries);
      if (opening) {
        downloads.focus();
        requestAnimationFrame(reportSize);
      }
    },
  );
  ipcRenderer.on(
    "cod:address-overlay-paint",
    (_event, { rows, fontSize, fontFamily, revision }: SuggestionPaint) => {
      if (downloadRevision !== undefined) {
        downloadRevision = undefined;
        downloads.panel.hidden = true;
        document.body.className = "browser-suggestion-popup";
        document.body.setAttribute("aria-hidden", "true");
        list.hidden = false;
      }
      document.documentElement.style.setProperty("--ui-font-size", fontSize);
      document.documentElement.style.setProperty(
        "--ui-font-family",
        fontFamily,
      );
      const scrollTop = list.scrollTop;
      list.replaceChildren(
        ...rows.map((item, index) => {
          const row = suggestionRow(item);
          if (!item.disabled)
            row.onclick = () =>
              ipcRenderer.send("cod:address-overlay-pick", revision, index);
          return row;
        }),
      );
      list.scrollTop = scrollTop;
      list
        .querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    },
  );
});
