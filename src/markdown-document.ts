import { Marked, type TokensList } from "marked";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

const parser = new Marked({ renderer: { html: () => "" } });

export function isMarkdownDocument(path: string): boolean {
  return /\.md(?:own|arkdown)?$/i.test(path);
}

export interface MarkdownBlock {
  html: string;
  text: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}
function plain(node: DefaultTreeAdapterMap["node"]): string {
  if ("value" in node) return node.value;
  if ("childNodes" in node) return node.childNodes.map(plain).join("");
  return "";
}
/** Shared rendered-text coordinates let the service verify exact preview quotes. */
export function markdownDocument(source: string): MarkdownBlock[] {
  const normalized = source.replace(/\r\n?/g, "\n");
  const tokens = parser.lexer(normalized);
  let line = 1,
    offset = 0;
  return tokens.map((token) => {
    const startLine = line;
    line += (token.raw.match(/\n/g) ?? []).length;
    const part = [token] as TokensList;
    part.links = tokens.links;
    const html = parser.parser(part);
    const text = plain(parseFragment(html));
    const start = offset;
    offset += text.length;
    return {
      html,
      text,
      start,
      end: offset,
      startLine,
      endLine:
        startLine + (token.raw.replace(/\n+$/, "").match(/\n/g) ?? []).length,
    };
  });
}
export interface TextFragment {
  view: "source" | "markdown";
  start: number;
  end: number;
}
export function documentFragment(source: string, fragment: TextFragment) {
  const { view, start, end } = fragment;
  if (
    !["source", "markdown"].includes(view) ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start
  )
    throw new Error("Select a non-empty text fragment");
  const blocks = view === "markdown" ? markdownDocument(source) : [];
  const text =
    view === "markdown" ? blocks.map((block) => block.text).join("") : source;
  if (end > text.length)
    throw new Error("Selection is outside the saved document");
  return {
    quote: text.slice(start, end),
    startLine:
      view === "source"
        ? source.slice(0, start).split("\n").length
        : blocks.find((b) => start >= b.start && start < b.end)!.startLine,
    endLine:
      view === "source"
        ? source.slice(0, end - 1).split("\n").length
        : blocks.find((b) => end > b.start && end <= b.end)!.endLine,
  };
}
