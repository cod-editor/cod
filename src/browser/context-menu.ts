import {
  Menu,
  clipboard,
  type BrowserWindow,
  type WebContents,
} from "electron";

// Native pages have their own renderer and do not inherit the app's DOM menus.
export function installPageContextMenu(
  contents: WebContents,
  window: BrowserWindow,
) {
  contents.on("context-menu", (_event, params) => {
    const run = (action: () => void) => () => {
      if (!contents.isDestroyed()) action();
    };
    const history = contents.navigationHistory;
    const menu = Menu.buildFromTemplate([
      {
        label: "Back",
        enabled: history.canGoBack(),
        click: run(() => history.goBack()),
      },
      {
        label: "Forward",
        enabled: history.canGoForward(),
        click: run(() => history.goForward()),
      },
      { label: "Reload", click: run(() => contents.reload()) },
      { type: "separator" },
      ...(params.isEditable
        ? [
            {
              label: "Cut",
              enabled: params.editFlags.canCut,
              click: run(() => contents.cut()),
            },
            {
              label: "Copy",
              enabled: params.editFlags.canCopy,
              click: run(() => contents.copy()),
            },
            {
              label: "Paste",
              enabled: params.editFlags.canPaste,
              click: run(() => contents.paste()),
            },
          ]
        : [
            {
              label: "Copy",
              enabled: !!params.selectionText,
              click: run(() => contents.copy()),
            },
          ]),
      { label: "Select all", click: run(() => contents.selectAll()) },
      ...(params.linkURL
        ? [
            { type: "separator" as const },
            {
              label: "Copy link address",
              click: () => clipboard.writeText(params.linkURL),
            },
          ]
        : []),
    ]);
    const close = () => menu.closePopup();
    contents.once("destroyed", close);
    menu.once("menu-will-close", () =>
      contents.removeListener("destroyed", close),
    );
    menu.popup({ window });
  });
}
