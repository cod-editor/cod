import assert from "node:assert/strict";
import test from "node:test";
import { eligibleSearchPhrase } from "../../src/browser/search-query.ts";
import { googleSearchSuggestions } from "../../src/browser/search-suggestions.ts";

test("network autocomplete accepts simple phrases and keeps ambiguous input local", () => {
  for (const value of [
    "grow a basil plant",
    "как вырастить базилик",
    "café au lait",
  ])
    assert.equal(eligibleSearchPhrase(value), true, value);
  for (const value of [
    "",
    "intranet",
    "localhost:3000",
    "report.docs",
    "report.docs next",
    "../local path",
    "https://example.test/path",
    "someone@example.test",
    "secret words",
    "api key",
    "word plus 123456",
    "first\nsecond",
    "x".repeat(25) + " example",
  ])
    assert.equal(eligibleSearchPhrase(value), false, value);
});

test("Google autocomplete uses an isolated bounded request and accepts plain deduplicated labels", async () => {
  const controller = new AbortController();
  let requests = 0;
  const fixture: typeof fetch = async (target, options) => {
    requests++;
    assert.equal(
      String(target),
      "https://www.google.com/complete/search?output=chrome&q=how+to+grow+basil",
    );
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.headers, undefined);
    return Response.json([
      "how to grow basil",
      [
        "how to grow basil",
        "  basil indoors ",
        "BASIL INDOORS",
        null,
        "bad\u202elabel",
        "x".repeat(161),
        "basil from seeds",
        "basil in pots",
        "basil near tomatoes",
        "too many suggestions",
      ],
    ]);
  };
  assert.deepEqual(
    await googleSearchSuggestions(
      "how to grow basil",
      controller.signal,
      fixture,
    ),
    [
      "basil indoors",
      "basil from seeds",
      "basil in pots",
      "basil near tomatoes",
    ],
  );
  assert.deepEqual(
    await googleSearchSuggestions("local.test", controller.signal, fixture),
    [],
  );
  controller.abort();
  assert.deepEqual(
    await googleSearchSuggestions(
      "how to grow basil",
      controller.signal,
      fixture,
    ),
    [],
  );
  assert.equal(requests, 1);
});

test("Google autocomplete rejects a mismatched echo and cancels oversized bodies", async () => {
  const signal = new AbortController().signal;
  assert.deepEqual(
    await googleSearchSuggestions("grow basil", signal, async () =>
      Response.json(["different phrase", ["basil indoors"]]),
    ),
    [],
  );
  let cancelled = false;
  const large = new ReadableStream({
    start(stream) {
      stream.enqueue(new Uint8Array(16 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.deepEqual(
    await googleSearchSuggestions(
      "grow basil",
      signal,
      async () => new Response(large),
    ),
    [],
  );
  assert.equal(cancelled, true);
});
