import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
for (const [name, definition] of Object.entries({
  typescript,
  javascript,
  python,
  json,
  markdown,
  bash,
  css,
  xml,
}))
  hljs.registerLanguage(name, definition);
export function languageFor(path: string): string {
  return (
    (
      {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        mjs: "javascript",
        py: "python",
        json: "json",
        md: "markdown",
        sh: "bash",
        css: "css",
        html: "xml",
        xml: "xml",
      } as Record<string, string>
    )[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"
  );
}
export function highlight(value: string, language: string): string {
  return value.length <= 200_000 && hljs.getLanguage(language)
    ? hljs.highlight(value, { language, ignoreIllegals: true }).value
    : value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
export function highlightedEditor(
  editor: HTMLTextAreaElement,
  path: string,
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "highlighted-editor";
  const language = languageFor(path);
  wrapper.dataset.language = language;
  const code = document.createElement("pre");
  code.className = "editor-colors";
  code.setAttribute("aria-hidden", "true");
  const markers = document.createElement("div");
  markers.className = "changed-lines";
  markers.setAttribute("aria-hidden", "true");
  editor.wrap = "off";
  editor.classList.add("highlight-overlay");
  const paint = () => {
    // Large single-line HTML can exceed Chromium's preformatted text painting
    // limits. Let the native editor draw it instead of hiding its text under an
    // empty overlay; also avoid a second full-size DOM copy.
    const highlighted = editor.value.length <= 200_000;
    wrapper.dataset.highlighted = String(highlighted);
    code.hidden = !highlighted;
    code.innerHTML = highlighted
      ? highlight(editor.value, wrapper.dataset.language ?? "plaintext") + "\n"
      : "";
    for (const token of code.querySelectorAll("span"))
      token.setAttribute("data-syntax-token", token.className);
    sync();
    positionChangedLines(wrapper);
  };
  const sync = () => {
    code.scrollTop = editor.scrollTop;
    code.scrollLeft = editor.scrollLeft;
    markers.style.transform = `translateY(${-editor.scrollTop}px)`;
  };
  editor.addEventListener("input", paint);
  editor.addEventListener("cod-editor-sync", paint);
  editor.addEventListener("scroll", sync);
  wrapper.append(code, markers, editor);
  paint();
  return wrapper;
}
export function setChangedLines(wrapper: HTMLElement, lines: number[]): void {
  const markers = wrapper.querySelector(".changed-lines")!;
  markers.replaceChildren();
  for (const line of lines) {
    const marker = document.createElement("span");
    marker.dataset.changedLine = String(line);
    marker.style.top = `calc(20px + ${line - 1} * var(--editor-font-size) * var(--editor-line-height, 1.65))`;
    marker.title = `Changed line ${line}`;
    markers.append(marker);
  }
  positionChangedLines(wrapper);
}

function positionChangedLines(wrapper: HTMLElement): void {
  const code = wrapper.querySelector<HTMLElement>(".editor-colors");
  if (!code || !wrapper.isConnected) return;
  const text = code.textContent ?? "";
  const starts = [0];
  for (let i = 0; i < text.length; i++)
    if (text[i] === "\n") starts.push(i + 1);
  for (const marker of wrapper.querySelectorAll<HTMLElement>(
    "[data-changed-line]",
  )) {
    let offset = starts[Number(marker.dataset.changedLine) - 1];
    if (offset === undefined) continue;
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length ?? 0;
      if (offset < length) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, Math.min(offset + 1, length));
        marker.style.top = `${range.getBoundingClientRect().top - code.getBoundingClientRect().top + code.scrollTop}px`;
        break;
      }
      offset -= length;
    }
  }
}
const repositionEditors = () => {
  requestAnimationFrame(() =>
    document
      .querySelectorAll<HTMLElement>(".highlighted-editor")
      .forEach(positionChangedLines),
  );
};
window.addEventListener("resize", repositionEditors);
