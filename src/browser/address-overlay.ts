import { WebContentsView, type BrowserWindow, type Rectangle } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AddressSuggestionPopup,
  SuggestionPaint,
} from "./address-suggestion-types";

export class BrowserAddressOverlay {
  private view?: WebContentsView;
  private ready = false;
  private current?: AddressSuggestionPopup;
  private bounds?: Rectangle;
  private dismissed?: Pick<AddressSuggestionPopup, "id" | "revision">;
  private lastPaint?: string;

  constructor(private readonly window: BrowserWindow) {
    window.on("blur", this.dismiss);
    window.once("closed", () => {
      const contents = this.view?.webContents;
      if (contents && !contents.isDestroyed()) contents.close();
    });
  }

  update(state: AddressSuggestionPopup | undefined, slot?: Rectangle): void {
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
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-frame-navigate", (event) => event.preventDefault());
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.ipc.on(
      "cod:address-overlay-pick",
      (event, revision: unknown, index: unknown) => {
        const state = this.current;
        if (
          event.senderFrame !== contents.mainFrame ||
          event.senderFrame.url !== pathToFileURL(file).href ||
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
    const state = this.current;
    if (!state?.presentation || !this.bounds) {
      view.setVisible(false);
      return;
    }
    view.setBounds(this.bounds);
    const root = this.window.contentView;
    if (root.children.at(-1) !== view) root.addChildView(view);
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
}
