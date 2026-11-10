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
  invoke<T>(request: OperationRequest): Promise<T> {
    return ipcRenderer.invoke("cod:invoke", request) as Promise<T>;
  },
  onState(callback: (state: AppState) => void): void {
    ipcRenderer.on("cod:state", (_event, state: AppState) => callback(state));
  },
  browserSelect(id) {
    ipcRenderer.send("cod:browser-select", id);
  },
  browserLayout(rectangles) {
    ipcRenderer.send("cod:browser-layout", rectangles);
  },
  browserFind(id, text, options) {
    return ipcRenderer.invoke("cod:browser-find", id, text, options);
  },
  browserStopFind(id) {
    ipcRenderer.send("cod:browser-stop-find", id);
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
