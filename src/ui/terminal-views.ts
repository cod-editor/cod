import { terminalTextSize } from "./appearance";
import { resolveKeybinding } from "../keyboard";
import { keyboardPlatform } from "./keyboard-ui";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { AppState, TerminalState, TerminalUiEvent } from "../types";
import type { Invoke } from "./contracts";
interface TerminalSession {
  id: string;
  container: HTMLElement;
  terminal: Terminal;
  fit: FitAddon;
  observer: ResizeObserver;
  sequence: number;
  ready: boolean;
  pending: TerminalUiEvent[];
}

export function createTerminalViews(getState: () => AppState, invoke: Invoke) {
  const terminalSessions = new Map<string, TerminalSession>();
  function createTerminalSession(
    container: HTMLElement,
    record: TerminalState,
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
      fontFamily: "Menlo, ui-monospace, monospace",
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
    terminal.attachCustomKeyEventHandler(
      (event) =>
        !event.defaultPrevented &&
        !resolveKeybinding(
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
        ),
    );
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
      id: record.id,
      container,
      terminal,
      fit,
      observer,
      sequence: 0,
      ready: false,
      pending: [],
    };
    terminalSessions.set(record.id, session);
    terminal.onData((data) => {
      void invoke("terminal.write", { id: record.id, data }).catch(
        () => undefined,
      );
    });
    requestTerminalFit(session);
    void invoke<TerminalState>("terminal.inspect", { id: record.id })
      .then((snapshot) => {
        session.sequence = snapshot.sequence;
        if (snapshot.output) terminal.write(snapshot.output);
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
      session.fit.fit();
      const record = getState().terminals.find(
        (terminal) => terminal.id === session.id,
      );
      if (
        record &&
        (record.cols !== session.terminal.cols ||
          record.rows !== session.terminal.rows)
      ) {
        void invoke("terminal.resize", {
          id: session.id,
          cols: session.terminal.cols,
          rows: session.terminal.rows,
        }).catch(() => undefined);
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
    for (const [id, session] of terminalSessions)
      if (!getState().terminals.some((t) => t.id === id)) {
        session.observer.disconnect();
        session.terminal.dispose();
        terminalSessions.delete(id);
      }
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
