import { ipcRenderer } from "electron";
import { suggestionRow } from "../ui/browser-suggestion-list";
import type { SuggestionPaint } from "./address-suggestion-types";

window.addEventListener("DOMContentLoaded", () => {
  const list = document.querySelector<HTMLElement>(".browser-suggestions")!;
  ipcRenderer.on(
    "cod:address-overlay-paint",
    (_event, { rows, fontSize, fontFamily, revision }: SuggestionPaint) => {
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
