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
