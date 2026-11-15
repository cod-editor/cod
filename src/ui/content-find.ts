import type { AppState, PaneState } from "../types";
import type { createFocusManager } from "./focus";
import { iconButton } from "./controls";

export function createContentFind(
  getState: () => AppState,
  focus: ReturnType<typeof createFocusManager>,
  terminalFind: (
    id: string,
    query: string,
    forward?: boolean,
    next?: boolean,
  ) => { current: number; total: number },
  layout: () => void,
) {
  let opened:
    | {
        pane: PaneState;
        bar: HTMLElement;
        input: HTMLInputElement;
        status: HTMLElement;
        origin: ReturnType<typeof focus.capture>;
        query: string;
        index: number;
        nativeRequest?: number;
      }
    | undefined;
  let revision = 0;
  let nativeQueue = Promise.resolve();
  let nativeEpoch = 0;
  type NativeResult = { activeMatchOrdinal: number; matches: number };
  const nativeResults = new Map<number, NativeResult>();
  const nativeWaiters = new Map<number, (result: NativeResult) => void>();
  function cancelNativeWaiters() {
    nativeEpoch++;
    for (const resolve of nativeWaiters.values())
      resolve({ activeMatchOrdinal: 0, matches: 0 });
    nativeWaiters.clear();
    nativeResults.clear();
  }
  const clearHighlight = () => CSS.highlights.delete("cod-find-match");
  function highlightRange(root: Node, start: number, end: number) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let offset = 0,
      node: Node | null,
      begun = false;
    while ((node = walker.nextNode())) {
      const size = node.textContent?.length ?? 0;
      if (!begun && start < offset + size) {
        range.setStart(node, start - offset);
        begun = true;
      }
      if (begun && end <= offset + size) {
        range.setEnd(node, end - offset);
        CSS.highlights.set("cod-find-match", new Highlight(range));
        return;
      }
      offset += size;
    }
  }
  const showCount = (current: number, total: number) => {
    if (opened)
      opened.status.textContent = total
        ? `${current} of ${total}`
        : "No matches";
  };
  const hostFor = (pane: PaneState) =>
    document.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`);
  function close(restore = true) {
    const previous = opened;
    if (!previous) return;
    opened = undefined;
    cancelNativeWaiters();
    clearHighlight();
    revision++;
    if (previous.pane.kind === "browser")
      window.cod.browserStopFind(previous.pane.browserId);
    if (previous.pane.kind === "terminal")
      terminalFind(previous.pane.terminalId, "");
    previous.bar.remove();
    layout();
    if (restore) focus.restore(previous.origin);
  }
  async function search(forward = true, next = false) {
    const view = opened;
    if (!view) return;
    const request = ++revision,
      query = view.input.value;
    clearHighlight();
    const changed = query !== view.query;
    view.query = query;
    if (!query) {
      cancelNativeWaiters();
      view.status.textContent = "";
      if (view.pane.kind === "terminal") terminalFind(view.pane.terminalId, "");
      if (view.pane.kind === "browser")
        window.cod.browserStopFind(view.pane.browserId);
      return;
    }
    if (view.pane.kind === "browser") {
      const browserId = view.pane.browserId;
      const epoch = nativeEpoch;
      view.nativeRequest = undefined;
      view.status.textContent = "Searching...";
      nativeQueue = nativeQueue.then(async () => {
        if (
          opened !== view ||
          epoch !== nativeEpoch ||
          view.input.value !== query
        )
          return;
        try {
          const id = await window.cod.browserFind(browserId, query, {
            forward,
            findNext: next && !changed,
          });
          if (opened !== view || epoch !== nativeEpoch || !view.input.value)
            return;
          const result =
            nativeResults.get(id) ??
            (await new Promise<NativeResult>((resolve) =>
              nativeWaiters.set(id, resolve),
            ));
          nativeResults.delete(id);
          if (request === revision && opened === view) {
            view.nativeRequest = id;
            showCount(result.activeMatchOrdinal, result.matches);
          }
        } catch {
          if (request === revision && opened === view)
            view.status.textContent = "Find unavailable";
        }
      });
      await nativeQueue;
      return;
    }
    if (view.pane.kind === "terminal") {
      const result = terminalFind(
        view.pane.terminalId,
        query,
        forward,
        next && !changed,
      );
      showCount(result.current, result.total);
      return;
    }
    const host = hostFor(view.pane);
    if (!host) return;
    const editor = host.querySelector<HTMLTextAreaElement>(".file-editor");
    const needle = query.toLocaleLowerCase();
    const matches: { start: number; end: number; node?: Text }[] = [];
    if (editor) {
      const text = editor.value.toLocaleLowerCase();
      for (
        let at = text.indexOf(needle);
        at >= 0;
        at = text.indexOf(needle, at + Math.max(1, needle.length))
      )
        matches.push({ start: at, end: at + query.length });
    } else {
      const content =
        host.querySelector<HTMLElement>(
          ".transcript,.markdown-preview,.repository-diff,.review-body",
        ) ?? host;
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          return parent?.closest(
            "textarea,input,script,style,.composer,.review-header,.review-form",
          ) || !parent?.getClientRects().length
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      });
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent?.toLocaleLowerCase() ?? "";
        for (
          let at = text.indexOf(needle);
          at >= 0;
          at = text.indexOf(needle, at + Math.max(1, needle.length))
        )
          matches.push({
            start: at,
            end: at + query.length,
            node: node as Text,
          });
      }
    }
    if (request !== revision || opened !== view) return;
    view.index = matches.length
      ? next && !changed
        ? (view.index + (forward ? 1 : -1) + matches.length) % matches.length
        : forward
          ? 0
          : matches.length - 1
      : -1;
    showCount(view.index + 1, matches.length);
    const match = matches[view.index];
    if (!match) return;
    if (editor) {
      editor.setSelectionRange(match.start, match.end);
      const mirror = editor
        .closest(".highlighted-editor")
        ?.querySelector(".editor-colors");
      if (mirror) highlightRange(mirror, match.start, match.end);
      const line = editor.value.slice(0, match.start).split("\n").length - 1;
      editor.scrollTop = Math.max(
        0,
        line * parseFloat(getComputedStyle(editor).lineHeight) -
          editor.clientHeight / 3,
      );
      editor.dispatchEvent(new Event("scroll"));
    } else if (match.node) {
      const range = document.createRange();
      range.setStart(match.node, match.start);
      range.setEnd(match.node, match.end);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      CSS.highlights.set("cod-find-match", new Highlight(range));
      match.node.parentElement?.scrollIntoView({ block: "center" });
    }
  }
  function open(pane: PaneState) {
    if (opened?.pane.id === pane.id) {
      opened.input.focus();
      opened.input.select();
      return;
    }
    close(false);
    const host = hostFor(pane),
      group = host?.closest<HTMLElement>(".tab-group");
    if (!host || !group) return;
    const origin = focus.capture();
    const bar = document.createElement("form");
    bar.className = "content-find";
    bar.setAttribute("role", "search");
    bar.setAttribute("aria-label", "Find in current content");
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Find in current content");
    input.placeholder = "Find";
    input.spellcheck = false;
    const status = document.createElement("span");
    status.setAttribute("role", "status");
    status.setAttribute("aria-label", "Find results");
    const previous = iconButton(
      "back",
      "Previous match",
      () => void search(false, true),
    );
    const next = iconButton(
      "forward",
      "Next match",
      () => void search(true, true),
    );
    const done = iconButton("close", "Close find", () => close());
    bar.append(input, status, previous, next, done);
    group.querySelector(".tab-bar")?.after(bar);
    opened = { pane, bar, input, status, origin, query: "", index: 0 };
    bar.onsubmit = (event) => {
      event.preventDefault();
      void search(true, true);
    };
    input.oninput = () => void search();
    bar.onkeydown = (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (!event.repeat) void search(!event.shiftKey, true);
      }
    };
    input.focus();
    layout();
  }
  window.cod.onBrowserFind((event) => {
    if (
      opened?.pane.kind !== "browser" ||
      opened.pane.browserId !== event.browserId ||
      !event.finalUpdate
    )
      return;
    const result = {
      activeMatchOrdinal: event.activeMatchOrdinal,
      matches: event.matches,
    };
    const resolve = nativeWaiters.get(event.requestId);
    if (resolve) {
      nativeWaiters.delete(event.requestId);
      resolve(result);
    } else {
      nativeResults.set(event.requestId, result);
      if (nativeResults.size > 32)
        nativeResults.delete(nativeResults.keys().next().value!);
    }
  });
  return {
    open,
    close,
    reconcile() {
      if (opened) {
        const workspace = getState().workspaces.find(
          (w) => w.id === getState().activeWorkspaceId,
        );
        const group = workspace?.groups?.find((g) =>
          g.paneIds.includes(opened!.pane.id),
        );
        if (
          !group ||
          group.hidden ||
          group.activePaneId !== opened.pane.id ||
          (workspace?.zoomedGroupId && workspace.zoomedGroupId !== group.id)
        ) {
          close(false);
          return;
        }
      }
      if (
        (opened &&
          !getState().workspaces.some((w) =>
            w.panes.some((p) => p.id === opened!.pane.id),
          )) ||
        (opened && !opened.bar.isConnected)
      )
        close(false);
    },
    dispose: () => close(false),
  };
}
