import { webUrl, contextLinkUrl } from "./address";
import {
  Menu,
  clipboard,
  dialog,
  type BrowserWindow,
  type WebContents,
} from "electron";

// Native pages have their own renderer and do not inherit the app's DOM menus.
export function installPageContextMenu(
  contents: WebContents,
  window: BrowserWindow,
  options: {
    inspect?: boolean;
    openLink?: (url: string) => Promise<unknown>;
    openExternal?: (url: string) => Promise<unknown>;
  } = {},
) {
  contents.on("context-menu", (_event, params) => {
    const run = (action: () => unknown | Promise<unknown>) => () => {
      if (contents.isDestroyed()) return;
      void Promise.resolve()
        .then(action)
        .catch((error) => {
          if (!contents.isDestroyed())
            void dialog
              .showMessageBox(window, {
                type: "error",
                message: "Could not complete page action",
                detail: error instanceof Error ? error.message : String(error),
              })
              .catch(() => undefined);
        });
    };
    const valid = (check: () => unknown) => {
      try {
        check();
        return true;
      } catch {
        return false;
      }
    };
    const link = params.linkURL;
    const canOpenLink =
      !!options.openLink &&
      valid(() => contextLinkUrl(link, contents.getURL()));
    const web = link || contents.getURL();
    const canOpenExternal = !!options.openExternal && valid(() => webUrl(web));
    let retainSource = false;
    const history = contents.navigationHistory;
    const menu = Menu.buildFromTemplate([
      ...(link
        ? [
            ...(canOpenLink
              ? [
                  {
                    label: "Open link in new tab",
                    click: () => {
                      retainSource = true;
                      run(() => options.openLink!(link))();
                    },
                  },
                ]
              : []),
            ...(canOpenExternal
              ? [
                  {
                    label: "Open link in system browser",
                    click: run(() => options.openExternal!(link)),
                  },
                ]
              : []),
            {
              label: "Copy link address",
              click: () => clipboard.writeText(link),
            },
            { type: "separator" as const },
          ]
        : canOpenExternal
          ? [
              {
                label: "Open page in system browser",
                click: run(() => options.openExternal!(web)),
              },
              { type: "separator" as const },
            ]
          : []),
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
      ...(options.inspect
        ? [
            { type: "separator" as const },
            {
              label: "Inspect element",
              click: run(() => {
                if (!contents.isDevToolsOpened())
                  contents.openDevTools({ mode: "detach" });
                contents.inspectElement(params.x, params.y);
              }),
            },
          ]
        : []),
    ]);
    const close = () => menu.closePopup();
    contents.once("destroyed", close);
    menu.once("menu-will-close", () =>
      contents.removeListener("destroyed", close),
    );
    menu.popup({
      window,
      callback: () => {
        // Restore native menu ownership immediately, never after a slow page load
        // when the user may already be typing in a different control.
        if (retainSource && !contents.isDestroyed()) contents.focus();
      },
    });
  });
}
