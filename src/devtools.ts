import type { WebContents } from "electron";
/** Electron owns inspector windows and their lifetime; Cod only routes manual entry. */
export function toggleDevTools(contents: WebContents): void {
  if (contents.isDestroyed()) return;
  if (contents.isDevToolsOpened()) contents.closeDevTools();
  else contents.openDevTools({ mode: "detach" });
}
