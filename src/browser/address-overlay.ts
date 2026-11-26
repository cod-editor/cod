import { WebContentsView, type BrowserWindow, type Rectangle } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AddressSuggestionPopup,
  SuggestionPaint,
} from "./address-suggestion-types";
import type {
  DownloadAction,
  DownloadPopup,
  DownloadRow,
} from "./download-presentation";

export class BrowserAddressOverlay {
  private view?: WebContentsView;
  private ready = false;
  private current?: AddressSuggestionPopup;
  private bounds?: Rectangle;
  private dismissed?: Pick<AddressSuggestionPopup, "id" | "revision">;
  private lastPaint?: string;
  private downloads?: { popup: DownloadPopup; entries: DownloadRow[] };
  private downloadHeight?: number;
  private dismissedDownload?: number;

  constructor(
    private readonly window: BrowserWindow,
    private readonly downloadAction: (
      id: string,
      action: DownloadAction,
    ) => Promise<unknown>,
  ) {
    window.on("blur", this.dismiss);
    window.once("closed", () => {
      const contents = this.view?.webContents;
      if (contents && !contents.isDestroyed()) contents.close();
    });
  }

  update(
    state: AddressSuggestionPopup | undefined,
    slot?: Rectangle,
    downloads?: { popup: DownloadPopup; entries: DownloadRow[] },
  ): void {
    if (
      downloads?.popup.revision !== this.dismissedDownload &&
      this.window.isFocused()
    ) {
      if (this.downloads?.popup.revision !== downloads?.popup.revision)
        this.downloadHeight = undefined;
      this.downloads = downloads;
    }
    if (!downloads) this.downloads = undefined;
    if (this.downloads) {
      this.current = undefined;
      if (!this.view) this.createView();
      this.paint();
      return;
    }
    if (
      state &&
      state.id === this.dismissed?.id &&
      state.revision === this.dismissed?.revision
    )
      return;
    this.dismissed = undefined;
    const presentation = state?.presentation;
    this.bounds =
      presentation && slot && this.valid(presentation, slot.height)
        ? {
            x: Math.round(slot.x),
            y: Math.round(slot.y),
            width: Math.floor(slot.width),
            height: Math.min(
              Math.floor(slot.height),
              Math.ceil(presentation.height),
            ),
          }
        : undefined;
    if (presentation && !this.bounds) state = undefined;
    if (state && !this.window.isFocused()) state = undefined;
    if (
      state?.id !== this.current?.id ||
      state?.revision !== this.current?.revision
    )
      this.lastPaint = undefined;
    this.current = state;
    if (state?.presentation && !this.view) this.createView();
    this.paint();
  }

  dismiss = (): void => {
    this.dismissDownload(false);
    const state = this.current;
    if (!state) return;
    this.dismissed = { id: state.id, revision: state.revision };
    this.clear();
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed())
      this.window.webContents.send(
        "cod:browser-suggestion-dismiss",
        state.id,
        state.revision,
      );
  };

  private dismissDownload(restore: boolean): void {
    const popup = this.downloads?.popup;
    if (!popup) return;
    this.dismissedDownload = popup.revision;
    this.downloadHeight = undefined;
    this.downloads = undefined;
    this.lastPaint = undefined;
    this.paint();
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      if (restore && this.window.isFocused()) this.window.webContents.focus();
      this.window.webContents.send(
        "cod:browser-download-dismiss",
        popup.revision,
        restore,
      );
    }
  }

  private clear() {
    this.current = undefined;
    this.lastPaint = undefined;
    this.paint();
  }

  private valid(
    { height, paint }: NonNullable<AddressSuggestionPopup["presentation"]>,
    slotHeight: number,
  ) {
    return (
      Number.isFinite(height) &&
      height >= 1 &&
      height <= slotHeight + 1 &&
      paint &&
      typeof paint.fontSize === "string" &&
      paint.fontSize.length <= 24 &&
      typeof paint.fontFamily === "string" &&
      paint.fontFamily.length <= 512 &&
      Array.isArray(paint.rows) &&
      paint.rows.length > 0 &&
      paint.rows.length <= 24 &&
      paint.rows.every(
        (row) =>
          row &&
          typeof row.title === "string" &&
          row.title.length <= 4096 &&
          typeof row.detail === "string" &&
          row.detail.length <= 16384 &&
          typeof row.selected === "boolean" &&
          typeof row.disabled === "boolean",
      )
    );
  }

  private createView() {
    const file = path.join(__dirname, "address-overlay.html");
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "address-overlay-preload.cjs"),
        partition: "cod-address-overlay",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const contents = view.webContents;
    this.view = view;
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-frame-navigate", (event) => event.preventDefault());
    contents.on("will-navigate", (event) => event.preventDefault());
    const owns = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
      event.senderFrame === contents.mainFrame &&
      event.senderFrame.url === pathToFileURL(file).href;
    contents.ipc.on(
      "cod:download-overlay-size",
      (event, revision: unknown, height: unknown) => {
        const popup = this.downloads?.popup;
        if (
          !owns(event) ||
          !popup ||
          revision !== popup.revision ||
          typeof height !== "number" ||
          !Number.isInteger(height) ||
          height < 1 ||
          height > popup.bounds.height
        )
          return;
        const first = this.downloadHeight === undefined;
        this.downloadHeight = height;
        this.paint();
        if (first && view.getVisible() && this.window.isFocused())
          contents.focus();
      },
    );
    contents.ipc.on(
      "cod:download-overlay-close",
      (event, revision: unknown) => {
        if (owns(event) && revision === this.downloads?.popup.revision)
          this.dismissDownload(true);
      },
    );
    contents.ipc.handle(
      "cod:download-overlay-action",
      async (event, revision: unknown, id: unknown, action: DownloadAction) => {
        if (
          !owns(event) ||
          !view.getVisible() ||
          revision !== this.downloads?.popup.revision ||
          typeof id !== "string" ||
          !this.downloads?.entries
            .find((item) => item.id === id)
            ?.actions.includes(action)
        )
          throw new Error("Download action is unavailable");
        try {
          await this.downloadAction(id, action);
        } catch {
          throw new Error("Could not perform the download action");
        }
      },
    );
    contents.ipc.on(
      "cod:address-overlay-pick",
      (event, revision: unknown, index: unknown) => {
        const state = this.current;
        if (
          !owns(event) ||
          !view.getVisible() ||
          !state?.presentation ||
          revision !== state.revision ||
          typeof index !== "number" ||
          !Number.isInteger(index) ||
          state.presentation.paint.rows[index]?.disabled !== false
        )
          return;
        this.dismissed = { id: state.id, revision: state.revision };
        this.clear();
        this.window.webContents.send(
          "cod:browser-suggestion-pick",
          state.id,
          state.revision,
          index,
        );
      },
    );
    const reset = () => {
      if (this.view !== view) return;
      this.view = undefined;
      this.ready = false;
      this.dismiss();
      if (!this.window.isDestroyed())
        this.window.contentView.removeChildView(view);
      if (!contents.isDestroyed()) contents.close();
    };
    contents.on("render-process-gone", reset);
    contents.once("destroyed", reset);
    contents.once("did-finish-load", () => {
      if (this.view !== view) return;
      this.ready = true;
      this.paint();
    });
    void contents.loadFile(file).catch(reset);
  }

  private paint() {
    const view = this.view;
    if (!view || !this.ready || view.webContents.isDestroyed()) return;
    const downloads = this.downloads;
    if (downloads) {
      const { bounds } = downloads.popup;
      this.placeAtTop(view, {
        ...bounds,
        height: Math.min(this.downloadHeight ?? bounds.height, bounds.height),
      });
      const key = JSON.stringify(downloads);
      if (key !== this.lastPaint) {
        this.lastPaint = key;
        view.webContents.send("cod:download-overlay-paint", downloads);
      }
      view.setVisible(this.downloadHeight !== undefined);
      return;
    }
    const state = this.current;
    if (!state?.presentation || !this.bounds) {
      view.setVisible(false);
      return;
    }
    this.placeAtTop(view, this.bounds);
    const next: SuggestionPaint = {
      ...state.presentation.paint,
      revision: state.revision,
    };
    const key = JSON.stringify(next);
    if (key !== this.lastPaint) {
      this.lastPaint = key;
      view.webContents.send("cod:address-overlay-paint", next);
    }
    view.setVisible(true);
  }

  private placeAtTop(view: WebContentsView, bounds: Rectangle) {
    view.setBounds(bounds);
    const root = this.window.contentView;
    if (root.children.at(-1) !== view) root.addChildView(view);
  }
}
