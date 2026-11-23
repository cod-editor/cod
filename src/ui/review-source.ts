import { highlight, languageFor } from "../editor-highlight";
import { documentFragment } from "../markdown-document";
import type { Range as CommentRange } from "../reviews/snapshots";
import { iconButton } from "../ui-kit";

function paintLines(text: string, path: string, lines: HTMLElement[]): void {
  if (text.length > 200_000) {
    text.split("\n").forEach((line, index) => {
      lines[index].textContent = line;
    });
    return;
  }
  const template = document.createElement("template");
  template.innerHTML = highlight(text, languageFor(path));
  let index = 0;
  const paint = (node: Node, scopes: HTMLElement[]) => {
    if (node instanceof Text) {
      const parts = node.data.split("\n");
      for (const [part, value] of parts.entries()) {
        if (part) index++;
        if (!value) continue;
        let target = lines[index];
        for (const scope of scopes) {
          const last = target.lastChild;
          if (last instanceof HTMLElement && last.className === scope.className)
            target = last;
          else {
            const span = document.createElement("span");
            span.className = scope.className;
            span.dataset.syntaxToken = scope.className;
            target.append(span);
            target = span;
          }
        }
        target.append(value);
      }
    } else if (node instanceof HTMLElement) {
      for (const child of node.childNodes) paint(child, [...scopes, node]);
    }
  };
  for (const node of template.content.childNodes) paint(node, []);
}

// Find an offset inside highlighted text without counting gutter or comment text.
export function reviewTextPoint(line: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent!.length;
    if (offset <= length) return { node, offset };
    offset -= length;
  }
  return { node: line as Node, offset: line.childNodes.length };
}

export function createReviewSource(
  source: string,
  path: string,
  comment: (range: CommentRange) => void,
) {
  const element = document.createElement("div");
  element.className = "review-source-layout";
  const editor = document.createElement("div");
  editor.className = "review-source-editor";
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", "Review source");
  editor.setAttribute("aria-multiline", "true");
  editor.setAttribute("aria-readonly", "true");
  // A native editing host permits keyboard selection across source lines.
  // Prevent mutations because the review's snapshot is immutable.
  editor.contentEditable = "true";
  editor.spellcheck = false;
  for (const type of ["beforeinput", "paste", "cut", "drop"])
    editor.addEventListener(type, (event) => {
      if (event.target === editor) event.preventDefault();
    });

  let start = 0;
  const lines = source.split("\n").map((raw, index) => {
    const row = document.createElement("div");
    row.className = "review-source-line";
    row.dataset.sourceLine = String(index + 1);
    const text = document.createElement("span");
    text.className = "review-source-text";
    const carriageReturn =
      start + raw.length < source.length && raw.endsWith("\r");
    const line = {
      row,
      text,
      start,
      length: raw.length - Number(carriageReturn),
    };
    start += raw.length + 1;
    row.append(text);
    return line;
  });
  paintLines(
    source.replaceAll("\r\n", "\n").replaceAll("\r", "␍"),
    path,
    lines.map(({ text }) => text),
  );
  for (const { row, text } of lines) {
    if (!text.childNodes.length) text.append(document.createElement("br"));
    editor.append(row);
  }

  const sourceLineCount =
    lines.length - Number(!source || source.endsWith("\n"));
  let actionLine = 1,
    canComment = false;
  const gutter = document.createElement("div");
  gutter.className = "review-source-gutter";
  const action = iconButton("review", "Add comment to line 1", () => {
    const range = lineRange(actionLine);
    if (range) comment(range);
  });
  action.hidden = true;
  action.classList.add("compact");
  gutter.append(action);
  const width = document.createElement("div");
  width.className = "review-source-width";
  width.append(gutter, editor);
  element.append(width);

  function indicate(line: number) {
    actionLine = line;
    const label = `Add comment to line ${line}`;
    action.title = label;
    action.setAttribute("aria-label", label);
    action.hidden = !canComment || line > sourceLineCount;
    action.style.top = `${lines[line - 1].row.offsetTop}px`;
  }

  function lineRange(line: number): CommentRange | undefined {
    if (line > sourceLineCount) return;
    const { start, length } = lines[line - 1];
    return {
      startLine: line,
      endLine: line,
      ...(length
        ? { fragment: { view: "source", start, end: start + length } }
        : {}),
    };
  }

  function point(node: Node, offset: number, end: boolean) {
    if (node === editor) {
      const children = [...editor.children];
      const rows = end
        ? children.slice(0, offset).reverse()
        : children.slice(offset);
      const row = rows.find((child) => child.hasAttribute("data-source-line"));
      return row
        ? {
            line: Number((row as HTMLElement).dataset.sourceLine),
            column: end ? undefined : 0,
          }
        : undefined;
    }
    const parent = node instanceof HTMLElement ? node : node.parentElement;
    const row = parent?.closest<HTMLElement>("[data-source-line]");
    if (!row || row.parentElement !== editor) return;
    const line = Number(row.dataset.sourceLine);
    const text = lines[line - 1].text;
    if (node === row) return { line, column: end ? undefined : 0 };
    if (!text.contains(node)) return;
    const prefix = document.createRange();
    prefix.selectNodeContents(text);
    prefix.setEnd(node, offset);
    return { line, column: prefix.toString().length };
  }

  function readSelection(): CommentRange | undefined {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    const first = point(range.startContainer, range.startOffset, false);
    const last = point(range.endContainer, range.endOffset, true);
    if (!first || !last) return;
    indicate(last.line);
    if (range.collapsed) return lineRange(first.line);
    const from = lines[first.line - 1];
    const to = lines[last.line - 1];
    const fragment = {
      view: "source" as const,
      start: from.start + (first.column ?? from.length),
      end: to.start + (last.column ?? to.length),
    };
    if (fragment.end <= fragment.start) return lineRange(first.line);
    const { startLine, endLine } = documentFragment(source, fragment);
    return { startLine, endLine, fragment };
  }

  // Home and End target a source line on external keyboards as well as in Linux.
  // Chromium otherwise interprets some of these chords as page movement on macOS.
  editor.addEventListener("keydown", (event) => {
    if (
      event.target !== editor ||
      event.altKey ||
      !["Home", "End"].includes(event.key)
    )
      return;
    const selection = window.getSelection();
    if (!selection?.focusNode || !editor.contains(selection.focusNode)) return;
    event.preventDefault();
    selection.modify(
      event.shiftKey ? "extend" : "move",
      event.key === "End" ? "forward" : "backward",
      event.ctrlKey || event.metaKey ? "documentboundary" : "lineboundary",
    );
  });

  const locate = (offset: number) => {
    let lo = 0,
      hi = lines.length;
    while (lo + 1 < hi) {
      const index = (lo + hi) >> 1;
      if (lines[index].start <= offset) lo = index;
      else hi = index;
    }
    return reviewTextPoint(lines[lo].text, offset - lines[lo].start);
  };

  element.addEventListener("pointermove", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const row = event.target.closest<HTMLElement>("[data-source-line]");
    if (!row || row.parentElement !== editor) return;
    const line = Number(row.dataset.sourceLine);
    if (line !== actionLine) indicate(line);
  });
  action.onpointerdown = (event) => event.preventDefault();
  editor.addEventListener("copy", (event) => {
    if (window.getSelection()?.isCollapsed || !event.clipboardData) return;
    const fragment = readSelection()?.fragment;
    if (!fragment) return;
    event.preventDefault();
    event.clipboardData.setData(
      "text/plain",
      source.slice(fragment.start, fragment.end),
    );
  });

  return {
    element,
    editor,
    readSelection,
    firstRange: () => lineRange(1),
    focus(range?: CommentRange) {
      editor.focus({ preventScroll: true });
      if (!range) return;
      const fragment = range.fragment;
      const start =
        fragment?.view === "source"
          ? fragment.start
          : (lines[range.startLine - 1]?.start ?? 0);
      const end = fragment?.view === "source" ? fragment.end : start;
      const first = locate(start);
      const last = locate(end);
      window
        .getSelection()
        ?.setBaseAndExtent(first.node, first.offset, last.node, last.offset);
      indicate(range.endLine);
    },
    setCommenting(enabled: boolean) {
      canComment = enabled;
      indicate(actionLine);
    },
    place(node: HTMLElement, endLine: number) {
      const row = lines[Math.max(0, Math.min(lines.length, endLine) - 1)].row;
      let sibling: Element = row;
      while (
        sibling.nextElementSibling !== node &&
        sibling.nextElementSibling?.hasAttribute("data-review-annotation")
      )
        sibling = sibling.nextElementSibling;
      if (sibling.nextElementSibling !== node) sibling.after(node);
      indicate(actionLine);
    },
  };
}
