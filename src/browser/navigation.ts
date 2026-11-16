/** A small URL history, deliberately excluding Chromium pageState/form payloads. */
export interface BrowserNavigation {
  entries: Array<{ url: string; title: string }>;
  index: number;
}
export function navigationWindow(length: number, index: number) {
  const start = Math.max(0, Math.min(index - 25, length - 50));
  return { start, end: Math.min(length, start + 50) };
}
export function normalizeNavigation(
  value: unknown,
): BrowserNavigation | undefined {
  if (!value || typeof value !== "object") return;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.entries) || !Number.isInteger(source.index)) return;
  const index = source.index as number;
  if (index < 0 || index >= source.entries.length) return;
  const { start, end } = navigationWindow(source.entries.length, index);
  const result: BrowserNavigation = { entries: [], index: 0 };
  let bytes = 0;
  for (let i = start; i < end; i++) {
    const entry = source.entries[i];
    let url: URL;
    try {
      url = new URL(entry?.url);
    } catch {
      if (i === index) return;
      else continue;
    }
    if (
      (!["http:", "https:", "file:"].includes(url.protocol) &&
        url.href !== "about:blank") ||
      (url.protocol === "file:" && !!url.host) ||
      url.username ||
      url.password ||
      url.href.length > 8192
    ) {
      if (i === index) return;
      continue;
    }
    // Do not manufacture a Back destination from the initial empty view.
    if (i === 0 && url.href === "about:blank" && index > 0) continue;
    const title =
      typeof entry.title === "string" ? entry.title.slice(0, 256) : "";
    bytes += Buffer.byteLength(url.href + title, "utf8");
    if (bytes > 65536) return;
    if (i === index) result.index = result.entries.length;
    result.entries.push({ url: url.href, title });
  }
  return result.entries.length ? result : undefined;
}
