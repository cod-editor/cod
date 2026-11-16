export const searchEngines = [
  "google",
  "duckduckgo",
  "bing",
  "yandex",
] as const;
export type SearchEngine = (typeof searchEngines)[number];
export const defaultSearchEngine: SearchEngine = "google";
/** Resolve explicit addresses locally; only ordinary text is sent to search. */
export function resolveAddress(
  input: string,
  engine: SearchEngine = defaultSearchEngine,
): string {
  const value = input.trim();
  if (!value) throw new Error("Enter an address or search query");
  if (value === "about:blank") return value;
  if (/^(?:https?|file):\/\//i.test(value)) {
    const url = new URL(value);
    if (url.protocol === "file:" && url.host)
      throw new Error("Only local file addresses are supported");
    return url.href;
  }
  // Recognize hosts before schemes: localhost:3000 is an address, not a protocol.
  if (!/\s/.test(value)) {
    const host = value.split(/[/?#]/, 1)[0];
    const local = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(
      host,
    );
    const domain = /^(?:[^.:@]+\.)+[^.:@]+(?::\d+)?$/u.test(host);
    const ipv6 = /^\[[\da-f:]+\](?::\d+)?$/i.test(host);
    if (local || domain || ipv6) {
      const url = new URL(`${local ? "http" : "https"}://${value}`);
      if (url.hostname) return url.href;
    }
  }
  if (
    /^(?:[a-z][a-z\d+.-]*:\/\/|javascript:|data:|file:|about:|mailto:)/i.test(
      value,
    )
  )
    throw new Error("Only HTTP, HTTPS and local file addresses are supported");
  const prefix = {
    google: "https://www.google.com/search?q=",
    duckduckgo: "https://duckduckgo.com/?q=",
    bing: "https://www.bing.com/search?q=",
    yandex: "https://yandex.ru/search/?text=",
  }[engine];
  return prefix + encodeURIComponent(value);
}

/** Encode a resolved native path without treating filename punctuation as URL syntax. */
export function localFileAddress(path: string): string {
  const windows = /^[a-z]:[\\/]/i.test(path);
  const normalized = windows ? path.replaceAll("\\", "/") : path;
  const pathname = normalized
    .split("/")
    .map((part, index) =>
      windows && index === 0 ? part : encodeURIComponent(part),
    )
    .join("/");
  return "file://" + (pathname.startsWith("/") ? pathname : "/" + pathname);
}

/** Explicit web targets only: never hand an arbitrary protocol to the platform. */
export function webUrl(value: string): string {
  if (!/^https?:\/\//i.test(value))
    throw new Error("Only HTTP and HTTPS links can open in the system browser");
  const url = new URL(value);
  if (!url.hostname) throw new Error("A web link must include a host");
  return url.href;
}
export function contextLinkUrl(value: string, source: string): string {
  if (value === "about:blank") return value;
  const url = new URL(value);
  if (
    url.protocol === "file:" &&
    !url.host &&
    new URL(source).protocol === "file:"
  )
    return url.href;
  return webUrl(value);
}

/** Resolve the explicitly selected URL or the URL under a source-editor caret. */
export function sourceWebUrl(
  value: string,
  start: number,
  end = start,
): string | undefined {
  const valid = (raw: string) => {
    try {
      return webUrl(raw);
    } catch {
      return undefined;
    }
  };
  if (start !== end) return valid(value.slice(start, end).trim());
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", start);
  const line = value.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  for (const match of line.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let raw = match[0].replace(/[.,;]+$/, "");
    for (const [open, close] of [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ])
      while (
        raw.endsWith(close) &&
        raw.split(close).length > raw.split(open).length
      )
        raw = raw.slice(0, -1);
    const offset = lineStart + match.index!;
    if (start >= offset && start <= offset + raw.length) return valid(raw);
  }
}
