import { terminalTextSize, appearanceSettings } from "./appearance";
import { resolveKeybinding } from "../keyboard";
import { keyboardPlatform } from "./keyboard-ui";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type {
  AppState,
  TerminalProcessState,
  TerminalState,
  TerminalUiEvent,
} from "../types";
import type { Invoke } from "./contracts";
interface TerminalBinding {
  record: () => TerminalProcessState | undefined;
  connected: () => boolean | undefined;
  invoke: Invoke;
  acceptsInput?: () => boolean;
}
interface TerminalSession {
  binding: TerminalBinding;
  id: string;
  container: HTMLElement;
  terminal: Terminal;
  fit: FitAddon;
  observer: ResizeObserver;
  sequence: number;
  ready: boolean;
  remoteConnected?: boolean;
  pending: TerminalUiEvent[];
}

function terminalOptions() {
  const settings = appearanceSettings();
  return {
    fontFamily: settings["terminal.fontFamily"],
    lineHeight: settings["terminal.lineHeight"],
    cursorStyle: settings["terminal.cursorStyle"] as
      "block" | "bar" | "underline",
    cursorBlink: settings["terminal.cursorBlink"],
    scrollback: settings["terminal.scrollback"],
  };
}
export function createTerminalViews(getState: () => AppState, invoke: Invoke) {
  const terminalSessions = new Map<string, TerminalSession>();
  function createTerminalSession(
    container: HTMLElement,
    record: TerminalProcessState,
    binding: TerminalBinding = {
      record: () => getState().terminals.find((item) => item.id === record.id),
      connected: () => remoteConnected(record),
      invoke,
    },
  ): void {
    const body = document.createElement("div");
    body.className = "pane-body terminal-body";
    const output = document.createElement("div");
    output.className = "terminal-output";
    output.setAttribute("role", "region");
    output.setAttribute("aria-label", "Terminal output");
    const currentStatus = document.createElement("div");
    currentStatus.className = "terminal-status";
    currentStatus.setAttribute("role", "status");
    currentStatus.textContent = record.error ?? record.status;
    body.append(output, currentStatus);
    container.append(body);

    const terminal = new Terminal({
      screenReaderMode: true,
      fontSize: terminalTextSize(),
      ...terminalOptions(),
      theme: {
        background: "#282c34",
        foreground: "#abb2bf",
        cursor: "#d7dae0",
        selectionBackground: "#454b57",
        black: "#282c34",
        red: "#e06c75",
        green: "#98c379",
        yellow: "#e5c07b",
        blue: "#61afef",
        magenta: "#c678dd",
        cyan: "#56b6c2",
        white: "#abb2bf",
      },
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.defaultPrevented) return false;
      const match = resolveKeybinding(
        {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          repeat: event.repeat,
          isComposing: event.isComposing,
          altGraph: event.getModifierState("AltGraph"),
          type: event.type,
        },
        keyboardPlatform,
        "terminal",
      );
      if (match?.command === "terminal.interrupt") {
        event.preventDefault();
        if (match.dispatch) terminal.input("\x03");
      }
      return !match;
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(output);
    const helper = output.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    helper?.setAttribute("aria-label", "Terminal input");
    let session: TerminalSession;
    const observer = new ResizeObserver(() => requestTerminalFit(session));
    observer.observe(output);
    session = {
      binding,
      id: record.id,
      container,
      terminal,
      fit,
      observer,
      sequence: 0,
      ready: false,
      remoteConnected: binding.connected(),
      pending: [],
    };
    terminalSessions.set(record.id, session);
    terminal.onData((data) => {
      if (binding.acceptsInput?.() === false) return;
      void binding
        .invoke("terminal.write", { id: record.id, data })
        .catch(() => undefined);
    });
    requestTerminalFit(session);
    if (session.remoteConnected !== false) readTerminalOutput(session);
  }

  function remoteConnected(record: TerminalProcessState): boolean | undefined {
    const remote = getState().remoteWorkspace;
    return remote?.ids.includes(record.workspaceId)
      ? remote.connected
      : undefined;
  }

  function readTerminalOutput(session: TerminalSession): void {
    session.ready = false;
    void session.binding
      .invoke<TerminalProcessState>("terminal.inspect", { id: session.id })
      .then((snapshot) => {
        session.sequence = snapshot.sequence;
        if (session.remoteConnected === true) session.terminal.reset();
        if (snapshot.output) session.terminal.write(snapshot.output);
        session.ready = true;
        for (const event of session.pending.splice(0)) {
          if (event.sequence > session.sequence)
            writeTerminalEvent(session, event);
        }
      })
      .catch(() => undefined);
  }

  function requestTerminalFit(session: TerminalSession): void {
    requestAnimationFrame(() => {
      if (!session.container.isConnected) return;
      const host =
        session.container.querySelector<HTMLElement>(".terminal-output");
      if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;
      if (session.terminal.options.fontSize !== terminalTextSize())
        session.terminal.options.fontSize = terminalTextSize();
      Object.assign(session.terminal.options, terminalOptions());
      session.fit.fit();
      const record = session.binding.record();
      if (
        record &&
        session.binding.acceptsInput?.() !== false &&
        (record.cols !== session.terminal.cols ||
          record.rows !== session.terminal.rows)
      ) {
        void session.binding
          .invoke("terminal.resize", {
            id: session.id,
            cols: session.terminal.cols,
            rows: session.terminal.rows,
          })
          .catch(() => undefined);
      }
    });
  }

  function writeTerminalEvent(
    session: TerminalSession,
    event: TerminalUiEvent,
  ): void {
    if (event.sequence <= session.sequence) return;
    session.sequence = event.sequence;
    if (event.data) session.terminal.write(event.data);
  }

  function reconcile() {
    for (const [id, session] of terminalSessions) {
      if (!session.binding.record()) {
        remove(id);
        continue;
      }
      const connected = session.binding.connected();
      if (connected !== session.remoteConnected) {
        session.remoteConnected = connected;
        if (connected) readTerminalOutput(session);
      }
    }
  }
  function remove(id: string): void {
    const session = terminalSessions.get(id);
    if (!session) return;
    session.observer.disconnect();
    session.terminal.dispose();
    terminalSessions.delete(id);
  }
  function update(
    record: TerminalState,
    active: boolean,
  ): HTMLElement | undefined {
    const session = terminalSessions.get(record.id);
    if (!session) return;
    session.container.dataset.active = String(active);
    const label = session.container.querySelector(".terminal-status");
    if (label) label.textContent = record.error ?? record.status;
    requestTerminalFit(session);
    return session.container;
  }
  let disposed = false;
  window.cod.onTerminal((event) => {
    if (disposed) return;
    const session = terminalSessions.get(event.terminalId);
    if (!session) return;
    if (!session.ready) session.pending.push(event);
    else writeTerminalEvent(session, event);
  });
  const findPositions = new Map<string, { query: string; index: number }>();
  function find(
    id: string,
    query: string,
    forward = true,
    next = false,
  ): { current: number; total: number } {
    const terminal = terminalSessions.get(id)?.terminal;
    if (!terminal || !query) {
      terminal?.clearSelection();
      findPositions.delete(id);
      return { current: 0, total: 0 };
    }
    const matches: { row: number; col: number; length: number }[] = [];
    const needle = query.toLocaleLowerCase();
    let text = "";
    let positions: { start: number; end: number }[] = [];
    const collect = () => {
      for (
        let offset = text.indexOf(needle);
        offset >= 0;
        offset = text.indexOf(needle, offset + Math.max(1, needle.length))
      ) {
        const start = positions[offset]?.start;
        const end = positions[offset + needle.length - 1]?.end;
        if (start !== undefined && end !== undefined)
          matches.push({
            row: Math.floor(start / terminal.cols),
            col: start % terminal.cols,
            length: end - start,
          });
      }
      text = "";
      positions = [];
    };
    for (let row = 0; row < terminal.buffer.active.length; row++) {
      const line = terminal.buffer.active.getLine(row);
      if (!line) continue;
      if (!line.isWrapped) collect();
      const continues = terminal.buffer.active.getLine(row + 1)?.isWrapped;
      const contentLength = line.translateToString(!continues).length;
      let originalLength = 0;
      for (
        let col = 0;
        col < line.length && originalLength < contentLength;
        col++
      ) {
        const cell = line.getCell(col);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || " ";
        const folded = chars.toLocaleLowerCase();
        const start = row * terminal.cols + col;
        for (let i = 0; i < folded.length; i++)
          positions.push({ start, end: start + cell.getWidth() });
        text += folded;
        originalLength += chars.length;
      }
    }
    collect();
    const previous = findPositions.get(id);
    const index = matches.length
      ? next && previous?.query === query
        ? (previous.index + (forward ? 1 : -1) + matches.length) %
          matches.length
        : forward
          ? 0
          : matches.length - 1
      : -1;
    findPositions.set(id, { query, index });
    if (index >= 0) {
      const match = matches[index];
      terminal.select(match.col, match.row, match.length);
      terminal.scrollToLine(match.row);
    } else terminal.clearSelection();
    return { current: index + 1, total: matches.length };
  }
  const resize = () => {
    for (const session of terminalSessions.values())
      requestTerminalFit(session);
  };
  window.addEventListener("resize", resize);
  return {
    create: createTerminalSession,
    focus: (id: string) => terminalSessions.get(id)?.terminal.focus(),
    remove,
    update,
    reconcile,
    find,
    dispose() {
      disposed = true;
      window.removeEventListener("resize", resize);
      for (const session of terminalSessions.values()) {
        session.observer.disconnect();
        session.terminal.dispose();
      }
      terminalSessions.clear();
    },
  };
}
