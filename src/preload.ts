import { injectBrowserAction } from "electron-chrome-extensions/browser-action";
injectBrowserAction();
import { contextBridge, ipcRenderer } from "electron";
import type {
  AppState,
  CodBridge,
  OperationRequest,
  TerminalUiEvent,
} from "./types";

const bridge: CodBridge = {
  onReleaseUpdate(callback) {
    ipcRenderer.on("cod:release-update", (_event, version) =>
      callback(version),
    );
  },
  openReleaseUpdate() {
    return ipcRenderer.invoke("cod:release-update-open");
  },
  toggleDevTools(id) {
    return ipcRenderer.invoke("cod:devtools", id);
  },
  onSettings(callback) {
    ipcRenderer.on("cod:settings", (_event, value) => callback(value));
  },
  openSettings() {
    return ipcRenderer.invoke("cod:settings-open");
  },
  getKeymap() {
    return ipcRenderer.invoke("cod:keymap");
  },
  onKeymap(callback) {
    ipcRenderer.on("cod:keymap", (_event, value) => callback(value));
  },
  openKeymap() {
    return ipcRenderer.invoke("cod:keymap-open");
  },
  chooseDirectory() {
    return ipcRenderer.invoke("cod:choose-directory") as Promise<string | null>;
  },
  chooseSaveFile(workspace: string, paneId: string) {
    return ipcRenderer.invoke("cod:choose-save-file", workspace, paneId);
  },
  invoke<T>(request: OperationRequest): Promise<T> {
    return ipcRenderer.invoke("cod:invoke", request) as Promise<T>;
  },
  onState(callback: (state: AppState) => void): void {
    ipcRenderer.on("cod:state", (_event, state: AppState) => callback(state));
  },
  browserSelect(id) {
    ipcRenderer.send("cod:browser-select", id);
  },
  browserLayout(rectangles, popup) {
    ipcRenderer.send("cod:browser-layout", rectangles, popup);
  },
  onBrowserSuggestionPick(callback) {
    ipcRenderer.on(
      "cod:browser-suggestion-pick",
      (_event, id, revision, index) => callback(id, revision, index),
    );
  },
  onBrowserSuggestionDismiss(callback) {
    ipcRenderer.on("cod:browser-suggestion-dismiss", (_event, id, revision) =>
      callback(id, revision),
    );
  },
  browserTabMenu(anchor, items) {
    return ipcRenderer.invoke("cod:browser-tab-menu", anchor, items);
  },
  browserHideForOverview(opening) {
    return ipcRenderer.invoke("cod:browser-hide-for-overview", opening);
  },
  browserOverviewBackdrop(ids, opening) {
    return ipcRenderer.invoke("cod:browser-overview-backdrop", ids, opening);
  },
  browserFind(id, text, options) {
    return ipcRenderer.invoke("cod:browser-find", id, text, options);
  },
  browserStopFind(id) {
    ipcRenderer.send("cod:browser-stop-find", id);
  },
  browserFindVisibility(id, visible) {
    ipcRenderer.send("cod:browser-find-visibility", id, visible);
  },
  onBrowserFindDismiss(callback) {
    ipcRenderer.on("cod:browser-find-dismiss", (_event, id) => callback(id));
  },
  onBrowserFind(callback) {
    ipcRenderer.on("cod:browser-find", (_event, value) => callback(value));
  },
  browserFocus(id) {
    ipcRenderer.send("cod:browser-focus", id);
  },
  onCommand(callback) {
    ipcRenderer.on("cod:command", (_event, value) => callback(value));
  },
  onTerminal(callback: (event: TerminalUiEvent) => void): void {
    ipcRenderer.on("cod:terminal", (_event, event: TerminalUiEvent) =>
      callback(event),
    );
  },
};

contextBridge.exposeInMainWorld("cod", bridge);
