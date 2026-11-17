import { highlightedEditor } from "../editor-highlight";
import { documentFragment, type TextFragment } from "../markdown-document";
import { renderMarkdown } from "../markdown-view";
import type { Range as CommentRange } from "../reviews/snapshots";
import { menu } from "./controls";

export function reviewDocument(
  source: string,
  path: string,
  preview: boolean,
  initial: CommentRange | undefined,
  changed: (range: CommentRange) => void,
  comment: () => void,
  report: (message: string) => void,
) {
  const element = document.createElement("div");
  element.className = "review-document";
  const editor = document.createElement("textarea");
  editor.className = "file-editor review-editor";
  editor.setAttribute("aria-label", "Review source");
  // Keep native caret movement: Chromium scrolls readonly textareas on arrows.
  editor.setAttribute("aria-readonly", "true");
  editor.addEventListener("beforeinput", (event) => event.preventDefault());
  editor.addEventListener("paste", (event) => event.preventDefault());
  editor.addEventListener("drop", (event) => event.preventDefault());
  editor.spellcheck = false;
  editor.value = source;
  editor.setSelectionRange(0, 0);
  const displayedSource = editor.value;
  // Textareas normalize CRLF; anchors remain offsets in the immutable file.
  const crlfOffsets = [...source.matchAll(/\r\n/g)].map(
    (match, index) => match.index! - index,
  );
  const rawOffset = (offset: number) =>
    offset + crlfOffsets.filter((position) => position < offset).length;
  const displayedOffset = (offset: number) =>
    source.slice(0, offset).replace(/\r\n?/g, "\n").length;
  const sourceView = highlightedEditor(editor, path);
  const rendered = document.createElement("article");
  rendered.className = "review-markdown";
  rendered.setAttribute("aria-label", "Review preview");
  rendered.setAttribute("role", "document");
  rendered.setAttribute("aria-readonly", "true");
  rendered.tabIndex = 0;
  // A read-only editing host supplies a real keyboard caret in formatted text.
  rendered.contentEditable = "true";
  rendered.spellcheck = false;
  rendered.addEventListener("beforeinput", (event) => {
    if (!(event.target as Element).closest("[data-review-annotation]"))
      event.preventDefault();
  });
  rendered.addEventListener("drop", (event) => event.preventDefault());
  rendered.addEventListener("paste", (event) => {
    if (!(event.target as Element).closest("[data-review-annotation]"))
      event.preventDefault();
  });
  rendered.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a")) event.preventDefault();
  });
  const sourceLayout = document.createElement("div");
  sourceLayout.className = "review-source-layout";
  const annotations = document.createElement("aside");
  annotations.className = "review-annotations";
  annotations.setAttribute("aria-label", "Anchored comments");
  sourceLayout.append(sourceView, annotations);
  element.append(sourceLayout, rendered);
  const anchored = new Map<HTMLElement, CommentRange>();
  // The saved source is immutable for this view. Draft/status updates need not
  // reparse it merely to repeat an unchanged pending editor's anchor quote.
  const contextAnchors = new WeakMap<HTMLElement, string>();
  function positionAnnotations() {
    sourceLayout.classList.toggle("has-comments", anchored.size > 0);
    let bottom = 0;
    const style = getComputedStyle(editor);
    const lineHeight = parseFloat(style.lineHeight) || 24;
    const stacked = getComputedStyle(annotations).position === "static";
    const ordered = [...anchored].sort((a, b) => a[1].endLine - b[1].endLine);
    for (const [index, [node, range]] of ordered.entries()) {
      node.contentEditable = "false";
      node.dataset.reviewAnnotation = "true";
      node.style.top = "";
      node.style.visibility = "";
      if (preview) {
        const blocks = [
          ...rendered.querySelectorAll<HTMLElement>(".markdown-block"),
        ];
        const block =
          blocks.find(
            (block) =>
              Number(block.dataset.startLine) <= range.endLine &&
              Number(block.dataset.endLine) >= range.endLine,
          ) ??
          blocks
            .filter((block) => Number(block.dataset.startLine) <= range.endLine)
            .at(-1);
        if (block) {
          let sibling: Element = block;
          while (
            sibling.nextElementSibling !== node &&
            sibling.nextElementSibling?.hasAttribute("data-review-annotation")
          )
            sibling = sibling.nextElementSibling;
          if (sibling.nextElementSibling !== node) sibling.after(node);
        } else if (rendered.lastElementChild !== node) rendered.append(node);
      } else {
        if (annotations.children[index] !== node)
          annotations.insertBefore(node, annotations.children[index] ?? null);
        if (stacked) continue;
        const top =
          parseFloat(style.paddingTop) +
          (range.endLine - 1) * lineHeight -
          editor.scrollTop;
        const outside = top < -lineHeight || top > editor.clientHeight;
        node.style.visibility = outside ? "hidden" : "";
        if (!outside) {
          const y = Math.max(bottom, top);
          node.style.top = `${y}px`;
          bottom = y + node.offsetHeight + 8;
        }
      }
    }
  }
  editor.addEventListener("scroll", positionAnnotations);
  const resizeObserver = new ResizeObserver(positionAnnotations);
  resizeObserver.observe(sourceLayout);

  let selected = initial;
  let renderedOnce = false;
  function remember(fragment: TextFragment) {
    const range = documentFragment(source, fragment);
    selected = { startLine: range.startLine, endLine: range.endLine, fragment };
    changed(selected);
    return selected;
  }
  function capture(): CommentRange | undefined {
    if (!preview) {
      let start = editor.selectionStart,
        end = editor.selectionEnd;
      if (start === end) {
        start =
          start === 0 ? 0 : displayedSource.lastIndexOf("\n", start - 1) + 1;
        const next = displayedSource.indexOf("\n", end);
        end = next < 0 ? displayedSource.length : next;
      }
      if (start !== end)
        return remember({
          view: "source",
          start: rawOffset(start),
          end: rawOffset(end),
        });
      return selected;
    }
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return selected;
    const range = selection.getRangeAt(0);
    if (!rendered.contains(range.commonAncestorContainer)) return selected;
    const blockFor = (node: Node) =>
      (node instanceof Element
        ? node
        : node.parentElement
      )?.closest<HTMLElement>(".markdown-block");
    const endpoint = (node: Node, count: number, end: boolean) => {
      if (node === rendered) {
        const block = rendered.children[end ? count - 1 : count] as
          HTMLElement | undefined;
        return block
          ? {
              block,
              node: block as Node,
              count: end ? block.childNodes.length : 0,
            }
          : undefined;
      }
      const block = blockFor(node);
      return block ? { block, node, count } : undefined;
    };
    const start = endpoint(range.startContainer, range.startOffset, false);
    const end = endpoint(range.endContainer, range.endOffset, true);
    if (!start || !end) return undefined;
    const first = start.block,
      last = end.block;
    if (
      first.querySelector("[data-diagram]") ||
      last.querySelector("[data-diagram]") ||
      range.cloneContents().querySelector("[data-diagram]")
    ) {
      report("Select diagram source in Source mode to comment on its code.");
      return undefined;
    }
    const offset = (block: HTMLElement, node: Node, count: number) => {
      const prefix = document.createRange();
      prefix.selectNodeContents(block);
      prefix.setEnd(node, count);
      return Number(block.dataset.textStart) + prefix.toString().length;
    };
    return remember({
      view: "markdown",
      start: offset(first, start.node, start.count),
      end: offset(last, end.node, end.count),
    });
  }
  for (const target of [editor, rendered]) {
    target.addEventListener("keyup", () => capture());
    target.addEventListener("mouseup", () => capture());
    target.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (capture())
        menu({ x: event.clientX, y: event.clientY }, [
          { label: "Add comment", run: comment },
        ]);
    });
  }
  function show() {
    sourceLayout.hidden = preview;
    rendered.hidden = !preview;
    if (preview && !renderedOnce) {
      renderedOnce = true;
      void renderMarkdown(rendered, source, () => element.isConnected)
        .then(positionAnnotations)
        .catch((error) => report(String(error)));
    }
  }
  function focus() {
    if (preview) rendered.focus({ preventScroll: true });
    else {
      const top = editor.scrollTop,
        left = editor.scrollLeft;
      editor.focus({ preventScroll: true });
      if (selected?.fragment?.view === "source")
        editor.setSelectionRange(
          displayedOffset(selected.fragment.start),
          displayedOffset(selected.fragment.end),
        );
      editor.scrollTop = top;
      editor.scrollLeft = left;
    }
  }
  if (initial?.fragment?.view === "source")
    editor.setSelectionRange(
      displayedOffset(initial.fragment.start),
      displayedOffset(initial.fragment.end),
    );
  show();
  return {
    element,
    capture,
    focus,
    dispose() {
      resizeObserver.disconnect();
      editor.removeEventListener("scroll", positionAnnotations);
    },
    clearAnnotations() {
      for (const node of anchored.keys()) {
        resizeObserver.unobserve(node);
        node.remove();
      }
      anchored.clear();
      sourceLayout.classList.remove("has-comments");
    },
    place(node: HTMLElement, range: CommentRange) {
      const label =
        range.startLine === range.endLine
          ? `Line ${range.startLine}`
          : `Lines ${range.startLine}-${range.endLine}`;
      if (node.classList.contains("review-comment-editor")) {
        let context = node.querySelector<HTMLElement>(".review-anchor-context");
        if (!context) {
          context = document.createElement("div");
          context.className = "review-anchor-context";
          context.append(
            document.createElement("span"),
            document.createElement("blockquote"),
          );
          node.prepend(context);
        }
        const anchor = `${range.startLine}:${range.endLine}:${range.fragment?.view}:${range.fragment?.start}:${range.fragment?.end}`;
        if (contextAnchors.get(node) !== anchor) {
          context.firstElementChild!.textContent = label;
          context.lastElementChild!.textContent = range.fragment
            ? documentFragment(source, range.fragment).quote
            : source
                .split("\n")
                .slice(range.startLine - 1, range.endLine)
                .join("\n");
          contextAnchors.set(node, anchor);
        }
      } else {
        const caption = node.querySelector(".review-comment-caption");
        if (caption && !caption.querySelector(".review-anchor-label")) {
          const anchor = document.createElement("span");
          anchor.className = "review-anchor-label";
          anchor.textContent = ` / ${label}`;
          caption.append(anchor);
        }
      }
      anchored.set(node, range);
      resizeObserver.observe(node);
      positionAnnotations();
    },
    toggle() {
      capture();
      preview = !preview;
      show();
      positionAnnotations();
      focus();
      return preview;
    },
  };
}
