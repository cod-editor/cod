import hljs from "highlight.js/lib/core";
import type { LanguageFn, Mode, ModeCallback } from "highlight.js";
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

const preventIdentifierEmphasis: ModeCallback = (match, response) => {
  const preceding = match.input?.slice(
    Math.max(0, (match.index ?? 0) - 2),
    match.index,
  );
  if (preceding && /[\p{L}\p{M}\p{N}_]$/u.test(preceding))
    response.ignoreMatch();
};

const preventIdentifierEnd: ModeCallback = (match, response) => {
  const following = match.input?.slice((match.index ?? 0) + match[0].length);
  if (match[0] && following && /^[\p{L}\p{M}\p{N}_]/u.test(following))
    response.ignoreMatch();
};

const editorMarkdown: LanguageFn = (api) => {
  const grammar = markdown(api);
  const visited = new Set<Mode>();
  const adjust = (mode: Mode) => {
    if (visited.has(mode)) return;
    visited.add(mode);
    if (mode.className === "emphasis" || mode.className === "strong") {
      for (const variant of mode.variants ?? []) {
        if (
          variant.begin instanceof RegExp &&
          variant.begin.source.startsWith("_")
        ) {
          variant["on:begin"] = preventIdentifierEmphasis;
          variant["on:end"] = preventIdentifierEnd;
        }
        // Recover at a paragraph boundary while an inline edit is incomplete.
        // Leave fenced and indented code modes free to span blank lines.
        if (variant.end instanceof RegExp)
          variant.end = new RegExp(
            `${variant.end.source}|(?=\\r?\\n[ \\t]*\\r?\\n)`,
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
