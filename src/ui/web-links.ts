import { webUrl, sourceWebUrl } from "../browser/address";
import type { Invoke } from "./contracts";
import { menu } from "./controls";

export function webLink(value: string): string | undefined {
  try {
    return webUrl(value);
  } catch {
    return undefined;
  }
}
/** Only the selected text or caret's line is relevant; never scan a transcript/file. */
export function focusedWebLink(element: Element | null): string | undefined {
  const anchor = element?.closest<HTMLAnchorElement>("a[href]");
  if (anchor) return webLink(anchor.getAttribute("href") ?? "");
  if (
    !(element instanceof HTMLTextAreaElement) ||
    !element.classList.contains("file-editor")
  )
    return;
  return sourceWebUrl(
    element.value,
    element.selectionStart,
    element.selectionEnd,
  );
}
export function webLinkMenu(
  anchor: HTMLElement | { x: number; y: number },
  value: string,
  workspace: string,
  invoke: Invoke,
  restoreFocus?: () => void,
  openHere?: (url: string) => void,
): boolean {
  const url = webLink(value);
  if (!url) return false;
  const run = (op: "browser.open" | "browser.open-external") => {
    void invoke(op, {
      url,
      ...(op === "browser.open" ? { workspace } : {}),
    }).catch(() => {});
  };
  menu(
    anchor,
    [
      {
        label: "Open link",
        command: "link.open",
        run: () => (openHere ? openHere(url) : run("browser.open")),
      },
      {
        label: "Open in system browser",
        command: "browser.openExternal",
        run: () => run("browser.open-external"),
      },
    ],
    { restoreFocus },
  );
  return true;
}
