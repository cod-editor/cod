export const searchEngines = [
  "google",
  "duckduckgo",
  "bing",
  "yandex",
] as const;
export type SearchEngine = (typeof searchEngines)[number];
/** Resolve explicit addresses locally; only ordinary text is sent to search. */
export function resolveAddress(
  input: string,
  engine: SearchEngine = "google",
): string {
  const value = input.trim();
  if (!value) throw new Error("Enter an address or search query");
  if (value === "about:blank") return value;
  if (/^https?:\/\//i.test(value)) return new URL(value).href;
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
    throw new Error("Only HTTP and HTTPS addresses are supported");
  const prefix = {
    google: "https://www.google.com/search?q=",
    duckduckgo: "https://duckduckgo.com/?q=",
    bing: "https://www.bing.com/search?q=",
    yandex: "https://yandex.ru/search/?text=",
  }[engine];
  return prefix + encodeURIComponent(value);
}
