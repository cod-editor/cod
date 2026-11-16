import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeNavigation } from "../../src/browser/navigation.ts";

test("Navigation restoration strips form state, bounds history and preserves the active position", () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({
    url: `https://example.invalid/${i}`,
    title: `Page ${i}`,
    pageState: "PRIVATE_FORM_SENTINEL",
  }));
  const saved = normalizeNavigation({ entries, index: 120 })!;
  assert.equal(saved.entries.length, 50);
  assert.equal(saved.entries[saved.index].url, entries[120].url);
  assert.equal(JSON.stringify(saved).includes("PRIVATE_FORM_SENTINEL"), false);
  assert.equal(normalizeNavigation({ entries, index: -1 }), undefined);
  assert.equal(normalizeNavigation({ entries, index: 201 }), undefined);
});
test("Navigation restoration rejects privileged active URLs and ignores the initial blank entry", () => {
  assert.equal(
    normalizeNavigation({
      entries: [{ url: "cod-artifact://unowned/file" }],
      index: 0,
    }),
    undefined,
  );
  assert.equal(
    normalizeNavigation({
      entries: [{ url: "https://user:secret@example.invalid" }],
      index: 0,
    }),
    undefined,
  );
  assert.deepEqual(
    normalizeNavigation({
      entries: [
        { url: "about:blank" },
        { url: "https://example.invalid", title: "Home" },
      ],
      index: 1,
    }),
    { entries: [{ url: "https://example.invalid/", title: "Home" }], index: 0 },
  );
});

test("Local report navigation survives normalization without Chromium form state", () => {
  const entries = [
    { url: "file:///tmp/report.html", title: "Report" },
    { url: "file:///tmp/evidence.txt", title: "Evidence" },
  ];
  assert.deepEqual(normalizeNavigation({ entries, index: 1 }), {
    entries,
    index: 1,
  });
  assert.equal(
    normalizeNavigation({
      entries: [{ url: "file://remote-share/file" }],
      index: 0,
    }),
    undefined,
  );
});
