import { documentFragment, type TextFragment } from "../markdown-document";
import { renderMarkdown } from "../markdown-view";
import type { Range as CommentRange } from "../reviews/snapshots";
import { menu } from "./controls";
import { createReviewSource } from "./review-source";

export function reviewDocument(
  source: string,
  path: string,
  preview: boolean,
  initial: CommentRange | undefined,
  changed: (range: CommentRange) => void,
  comment: (range: CommentRange) => void,
  report: (message: string) => void,
) {
  const element = document.createElement("div");
  element.className = "review-document";
  const sourceView = createReviewSource(source, path, comment);
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
  element.append(sourceView.element, rendered);
  const anchored = new Map<HTMLElement, CommentRange>();
  // The immutable snapshot lets us retain a pending form's exact anchor quote.
  const contextAnchors = new WeakMap<HTMLElement, string>();
  function positionAnnotations() {
    const blocks = preview
      ? [...rendered.querySelectorAll<HTMLElement>(".markdown-block")]
      : [];
    for (const [node, range] of anchored) {
      node.contentEditable = "false";
      node.dataset.reviewAnnotation = "true";
      if (!preview) {
        sourceView.place(node, range.endLine);
        continue;
      }
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
    }
  }

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
      const range =
        sourceView.readSelection() ?? selected ?? sourceView.firstRange();
      if (range) {
        selected = range;
        changed(range);
      }
      return range;
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
  for (const target of [sourceView.editor, rendered]) {
    const fromAnnotation = (event: Event) =>
      event.target instanceof Element &&
      !!event.target.closest("[data-review-annotation]");
    target.addEventListener("keyup", (event) => {
      if (!fromAnnotation(event)) capture();
    });
    target.addEventListener("mouseup", (event) => {
      if (!fromAnnotation(event)) capture();
    });
    target.addEventListener("contextmenu", (event) => {
      if (fromAnnotation(event)) return;
      event.preventDefault();
      const range = capture();
      if (range)
        menu({ x: event.clientX, y: event.clientY }, [
          { label: "Add comment", run: () => comment(range) },
        ]);
    });
  }
  function show() {
    sourceView.element.hidden = preview;
    rendered.hidden = !preview;
    if (preview && !renderedOnce) {
      renderedOnce = true;
      void renderMarkdown(rendered, source, () => element.isConnected)
        .then(positionAnnotations)
        .catch((error) => report(String(error)));
    }
  }
  function focus(range = selected) {
    if (preview) rendered.focus({ preventScroll: true });
    else sourceView.focus(range);
  }
  show();
  return {
    element,
    capture,
    focus,
    setCommenting: sourceView.setCommenting,
    clearAnnotations(retain?: HTMLElement) {
      for (const node of anchored.keys()) {
        if (node !== retain) node.remove();
      }
      anchored.clear();
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
