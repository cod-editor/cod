import { eligibleSearchPhrase } from "./search-query.ts";

const endpoint = "https://www.google.com/complete/search";
const maxResponseBytes = 16 * 1024;
const maxRows = 4;

export async function googleSearchSuggestions(
  query: string,
  signal: AbortSignal,
  request = fetch,
): Promise<string[]> {
  if (!eligibleSearchPhrase(query) || signal.aborted) return [];
  const url = new URL(endpoint);
  url.searchParams.set("output", "chrome");
  url.searchParams.set("q", query);
  const response = await request(url, {
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(1_200)]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return [];
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxResponseBytes) {
      await reader.cancel();
      return [];
    }
    text += decoder.decode(value, { stream: true });
  }
  const payload: unknown = JSON.parse(text + decoder.decode());
  if (
    !Array.isArray(payload) ||
    payload[0] !== query ||
    !Array.isArray(payload[1])
  )
    return [];
  const seen = new Set([query.toLocaleLowerCase()]);
  const terms: string[] = [];
  for (const item of payload[1]) {
    if (typeof item !== "string" || /[\p{Cc}\p{Cf}]/u.test(item)) continue;
    const term = item.trim();
    const key = term.toLocaleLowerCase();
    if (!term || term.length > 160 || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === maxRows) break;
  }
  return terms;
}
