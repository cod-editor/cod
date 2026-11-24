import hljs from "highlight.js/lib/core";
import type { LanguageFn, Mode } from "highlight.js";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import yaml from "highlight.js/lib/languages/yaml";

const editorMarkdown: LanguageFn = (api) => {
  const grammar = markdown(api);
  // Highlight.js applies the language's flags when it compiles the combined
  // matcher. Check identifier boundaries there instead of rejecting matches
  // in callbacks, which can rescan the remaining input for every underscore.
  grammar.unicodeRegex = true;
  const identifier = String.raw`[\p{L}\p{M}\p{N}_]`;
  const visited = new Set<Mode>();
  const adjust = (mode: Mode) => {
    if (visited.has(mode)) return;
    visited.add(mode);
    if (mode.className === "emphasis" || mode.className === "strong") {
      for (const variant of mode.variants ?? []) {
        const underscoreBegin =
          variant.begin instanceof RegExp &&
          variant.begin.source.startsWith("_")
            ? variant.begin.source
            : undefined;
        if (underscoreBegin)
          variant.begin = new RegExp(
            `(?<!${identifier})${underscoreBegin}`,
            "u",
          );
        // Recover at a paragraph boundary while an inline edit is incomplete.
        // Leave fenced and indented code modes free to span blank lines.
        if (variant.end instanceof RegExp)
          variant.end = new RegExp(
            `${variant.end.source}${underscoreBegin ? `(?!${identifier})` : ""}|(?=\\r?\\n[ \\t]*\\r?\\n)`,
            "u",
          );
      }
    }
    for (const child of [...(mode.contains ?? []), ...(mode.variants ?? [])])
      if (child !== "self") adjust(child);
  };
  adjust(grammar);
  return grammar;
};

for (const [name, definition] of Object.entries({
  typescript,
  javascript,
  python,
  json,
  markdown: editorMarkdown,
  bash,
  css,
  xml,
  c,
  cpp,
  csharp,
  diff,
  dockerfile,
  go,
  ini,
  java,
  kotlin,
  lua,
  makefile,
  perl,
  php,
  ruby,
  rust,
  scss,
  sql,
  swift,
  yaml,
}))
  hljs.registerLanguage(name, definition);

const languageByExtension = new Map(
  Object.entries({
    bash: "bash",
    c: "c",
    cc: "cpp",
    cjs: "javascript",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    cts: "typescript",
    cxx: "cpp",
    diff: "diff",
    dockerfile: "dockerfile",
    go: "go",
    h: "c",
    hh: "cpp",
    hpp: "cpp",
    htm: "xml",
    html: "xml",
    hxx: "cpp",
    ini: "ini",
    java: "java",
    js: "javascript",
    json: "json",
    json5: "json",
    jsonc: "json",
    jsx: "javascript",
    kt: "kotlin",
    kts: "kotlin",
    lua: "lua",
    markdown: "markdown",
    md: "markdown",
    mk: "makefile",
    mjs: "javascript",
    mts: "typescript",
    patch: "diff",
    php: "php",
    pl: "perl",
    pm: "perl",
    py: "python",
    pyi: "python",
    rb: "ruby",
    rs: "rust",
    scss: "scss",
    sh: "bash",
    sql: "sql",
    svg: "xml",
    swift: "swift",
    toml: "ini",
    ts: "typescript",
    tsx: "typescript",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
  }),
);
const languageByFilename = new Map(
  Object.entries({
    ".bash_profile": "bash",
    ".bashrc": "bash",
    ".profile": "bash",
    ".zprofile": "bash",
    ".zshrc": "bash",
    gemfile: "ruby",
    gnumakefile: "makefile",
    makefile: "makefile",
    rakefile: "ruby",
  }),
);

export function languageFor(path: string): string {
  const filename = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  const named = languageByFilename.get(filename);
  if (named) return named;
  if (/^(?:dockerfile|containerfile)(?:\..+)?$/.test(filename))
    return "dockerfile";
  const dot = filename.lastIndexOf(".");
  return (
    (dot > 0 ? languageByExtension.get(filename.slice(dot + 1)) : undefined) ??
    "plaintext"
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
interface EditorLayout {
  editor: HTMLTextAreaElement;
  code: HTMLPreElement;
  gutter: HTMLElement;
  changed: readonly number[];
  starts: number[];
  text?: string;
  mirrorText?: string;
  language?: string;
  wrap: boolean;
  nodes: { start: number; node: Text }[];
  tops: Map<number, number>;
  height: number;
  padding: number;
  frame?: number;
  visible?: string;
  sizing?: string;
}

const layouts = new WeakMap<HTMLElement, EditorLayout>();
const observer = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const layout = layouts.get(target as HTMLElement);
    if (layout) scheduleLayout(layout);
  }
});

window.addEventListener("resize", () => {
  for (const wrapper of document.querySelectorAll<HTMLElement>(
    ".highlighted-editor",
  )) {
    const layout = layouts.get(wrapper);
    if (layout) scheduleLayout(layout);
  }
});

export function highlightedEditor(editor: HTMLTextAreaElement): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "highlighted-editor";
  const code = document.createElement("pre");
  code.className = "editor-colors";
  code.setAttribute("aria-hidden", "true");
  const gutter = document.createElement("div");
  gutter.className = "editor-gutter";
  gutter.setAttribute("aria-hidden", "true");
  editor.wrap = "off";
  editor.classList.add("highlight-overlay");
  const layout: EditorLayout = {
    editor,
    code,
    gutter,
    changed: [],
    starts: [0],
    wrap: false,
    nodes: [],
    tops: new Map(),
    height: 0,
    padding: 0,
  };
  layouts.set(wrapper, layout);
  const schedule = () => scheduleLayout(layout);
  editor.addEventListener("input", schedule);
  editor.addEventListener("cod-editor-sync", schedule);
  editor.addEventListener("scroll", () => syncScroll(layout));
  wrapper.append(code, gutter, editor);
  return wrapper;
}

export function updateHighlightedEditor(
  wrapper: HTMLElement,
  path: string,
  changed: readonly number[],
): void {
  const layout = layouts.get(wrapper)!;
  wrapper.dataset.language = languageFor(path);
  if (layout.changed !== changed) {
    layout.changed = changed;
    layout.visible = undefined;
  }
  observer.observe(wrapper);
  scheduleLayout(layout);
}

export function disposeHighlightedEditor(wrapper: HTMLElement): void {
  observer.unobserve(wrapper);
  const frame = layouts.get(wrapper)?.frame;
  if (frame !== undefined) cancelAnimationFrame(frame);
}

function scheduleLayout(layout: EditorLayout): void {
  if (layout.frame !== undefined) return;
  layout.frame = requestAnimationFrame(() => {
    layout.frame = undefined;
    prepareLayout(layout);
  });
}

function prepareLayout(layout: EditorLayout): boolean {
  const { editor, code } = layout;
  const wrapper = editor.parentElement!;
  if (!editor.isConnected || !editor.clientHeight) return false;
  const value = editor.value;
  const changedText = layout.text !== value;
  if (changedText) {
    layout.text = value;
    layout.starts = [0];
    for (let i = 0; i < value.length; i++)
      if (value[i] === "\n") layout.starts.push(i + 1);
    wrapper.style.setProperty(
      "--editor-line-digits",
      String(String(layout.starts.length).length),
    );
  }
  const style = getComputedStyle(editor);
  const wrap = style.whiteSpace !== "pre";
  const language = wrapper.dataset.language ?? "plaintext";
  const highlighted = value.length <= 200_000;
  const mirrorText = highlighted || wrap ? value : undefined;
  const repaint =
    mirrorText !== layout.mirrorText || language !== layout.language;
  if (repaint) {
    if (highlighted) {
      code.innerHTML = highlight(value, language) + "\n";
      for (const token of code.querySelectorAll("span"))
        token.dataset.syntaxToken = token.className;
    } else code.textContent = mirrorText === undefined ? "" : mirrorText + "\n";
    layout.nodes = [];
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      layout.nodes.push({ start: offset, node: node as Text });
      offset += node.textContent!.length;
    }
    layout.mirrorText = mirrorText;
    layout.language = language;
  }
  wrapper.dataset.highlighted = String(highlighted);
  const width = editor.clientWidth + "px";
  const height = editor.clientHeight + "px";
  const sizing = [
    width,
    height,
    style.fontFamily,
    style.fontSize,
    style.lineHeight,
    style.tabSize,
    style.whiteSpace,
  ].join(":");
  if (repaint || changedText || layout.sizing !== sizing) {
    layout.wrap = wrap;
    layout.height = parseFloat(style.lineHeight);
    layout.padding = parseFloat(style.paddingTop);
    layout.tops.clear();
    layout.visible = undefined;
    layout.sizing = sizing;
    code.style.width = width;
    code.style.height = height;
  }
  syncScroll(layout);
  return true;
}

// Match the native editor's wrap width and use the syntax mirror's real text
// positions for both the gutter and navigation. Only measure visible lines.
function textRect(layout: EditorLayout, offset: number): DOMRect | undefined {
  const index = precedingIndex(layout.nodes, ({ start }) => start <= offset);
  const token = layout.nodes[index];
  if (!token) return;
  const range = document.createRange();
  range.setStart(token.node, offset - token.start);
  range.setEnd(
    token.node,
    Math.min(offset - token.start + 1, token.node.length),
  );
  return range.getBoundingClientRect();
}

function precedingIndex<T>(
  values: readonly T[],
  matches: (value: T, index: number) => boolean,
): number {
  let first = 0,
    end = values.length;
  while (first < end) {
    const middle = (first + end) >>> 1;
    if (matches(values[middle], middle)) first = middle + 1;
    else end = middle;
  }
  return first - 1;
}

function lineTop(layout: EditorLayout, index: number): number {
  if (!layout.wrap || index === 0)
    return layout.padding + index * layout.height;
  const cached = layout.tops.get(index);
  if (cached !== undefined) return cached;
  const top =
    layout.padding +
    (textRect(layout, layout.starts[index])!.top - textRect(layout, 0)!.top);
  layout.tops.set(index, top);
  return top;
}

function syncScroll(layout: EditorLayout): void {
  const { editor, code, gutter, starts } = layout;
  if (!layout.height || !editor.clientHeight) return;
  code.scrollTop = editor.scrollTop;
  code.scrollLeft = editor.scrollLeft;
  const first = Math.max(
    0,
    precedingIndex(
      starts,
      (_, index) => lineTop(layout, index) <= editor.scrollTop,
    ),
  );
  let end = first;
  while (
    end < starts.length &&
    lineTop(layout, end) < editor.scrollTop + editor.clientHeight
  )
    end++;
  const visible = first + ":" + end;
  if (layout.visible !== visible) {
    const rows: HTMLElement[] = [];
    for (let index = first; index < end; index++) {
      const line = index + 1;
      const row = document.createElement("div");
      row.dataset.lineNumber = String(line);
      row.textContent = String(line);
      row.style.top = lineTop(layout, index) + "px";
      if (layout.changed.includes(line)) {
        row.dataset.changedLine = String(line);
        row.title = "Changed line " + line;
      }
      rows.push(row);
    }
    gutter.replaceChildren(...rows);
    layout.visible = visible;
  }
  gutter.style.transform = `translateY(${-editor.scrollTop}px)`;
}

export function selectEditorLine(
  editor: HTMLTextAreaElement,
  line: number,
): boolean {
  const layout = layouts.get(editor.parentElement!);
  if (!layout || !prepareLayout(layout)) return false;
  const index = Math.min(line - 1, layout.starts.length - 1);
  const offset = layout.starts[index];
  editor.setSelectionRange(offset, offset);
  editor.scrollLeft = 0;
  editor.scrollTop = Math.max(
    0,
    lineTop(layout, index) - editor.clientHeight / 3,
  );
  syncScroll(layout);
  return true;
}

export function revealEditorOffset(
  editor: HTMLTextAreaElement,
  offset: number,
): void {
  const layout = layouts.get(editor.parentElement!);
  if (!layout || !prepareLayout(layout)) return;
  const index = Math.max(
    0,
    precedingIndex(layout.starts, (start) => start <= offset),
  );
  const top = layout.wrap
    ? layout.padding + textRect(layout, offset)!.top - textRect(layout, 0)!.top
    : lineTop(layout, index);
  editor.scrollTop = Math.max(0, top - editor.clientHeight / 3);
  syncScroll(layout);
}
