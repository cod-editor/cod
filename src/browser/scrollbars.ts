import { webFrameMain, type WebContents } from "electron";

/** Defaults only; no site layout, fonts, colors, or custom scrolling are changed. */
export function installScrollbarStyle(
  contents: WebContents,
  css: string,
): void {
  contents.on("dom-ready", () => {
    if (!contents.isDestroyed())
      void contents
        .insertCSS(css, { cssOrigin: "author" })
        .catch(() => undefined);
  });
  // WebContents.insertCSS addresses the main page. Subframes have no insertCSS
  // API, so add an ordinary stylesheet there; restrictive frame CSP may reject it.
  const frameScript = `(() => {
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(css)};
    (document.head || document.documentElement)?.append(style);
  })()`;
  contents.on("did-frame-finish-load", (_event, main, processId, routingId) => {
    if (main || contents.isDestroyed()) return;
    const frame = webFrameMain.fromId(processId, routingId);
    if (frame && !frame.detached)
      void frame.executeJavaScript(frameScript).catch(() => undefined);
  });
}
