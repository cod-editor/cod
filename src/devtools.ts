import type { WebContents } from "electron";
import {
  nativeKeyInput,
  resolveKeybinding,
  type KeyboardSurface,
} from "./keyboard";

/** Electron owns inspector windows and their lifetime; Cod only routes manual entry. */
export function toggleDevTools(contents: WebContents): void {
  if (contents.isDestroyed()) return;
  if (contents.isDevToolsOpened()) contents.closeDevTools();
  else contents.openDevTools({ mode: "detach" });
}

const boundInspectors = new WeakSet<WebContents>();
export function installDevToolsKeys(
  owner: WebContents,
  surface: KeyboardSurface,
): void {
  owner.on("devtools-opened", () => {
    const inspector = owner.devToolsWebContents;
    if (!inspector || boundInspectors.has(inspector)) return;
    boundInspectors.add(inspector);
    inspector.on("before-input-event", (event, input) => {
      const match = resolveKeybinding(
        nativeKeyInput(input),
        process.platform === "darwin" ? "darwin" : "linux",
        surface,
      );
      if (match?.command !== "devtools.toggle") return;
      event.preventDefault();
      if (match.dispatch) toggleDevTools(owner);
    });
  });
}
