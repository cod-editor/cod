import { test } from "node:test";
import assert from "node:assert/strict";
import {
  webUrl,
  contextLinkUrl,
  sourceWebUrl,
} from "../../src/browser/address.ts";
test("system handoff admits explicit web URLs without dropping query or fragment", () => {
  const url = "https://example.org/a_(b)?q=one%26two#part";
  assert.equal(webUrl(url), url);
  for (const raw of [
    "mailto:test@example.org",
    "javascript:alert(1)",
    "file:///tmp/example",
    "data:text/html,test",
    "about:blank",
    "https://",
    "example.org",
    "http:example.org",
  ])
    assert.throws(() => webUrl(raw));
});
test("context tabs retain remote-to-file and privileged-page boundaries", () => {
  assert.equal(
    contextLinkUrl("file:///tmp/a%20b.html", "file:///tmp/index.html"),
    "file:///tmp/a%20b.html",
  );
  assert.equal(
    contextLinkUrl(
      "https://example.org/page",
      "cod-artifact://example/form.html",
    ),
    "https://example.org/page",
  );
  for (const [url, source] of [
    ["file:///tmp/private", "https://example.org"],
    ["file://server/share", "file:///tmp/index.html"],
    ["cod-artifact://example/form.html", "https://example.org"],
    ["chrome-extension://id/page", "https://example.org"],
  ])
    assert.throws(() => contextLinkUrl(url, source));
});
test("source actions use the selected link or exact caret target with balanced punctuation", () => {
  const url = "https://example.org/a_(b)?q=one%26two#part";
  const source = `first https://example.org/first\n// ([Second](${url})). after`;
  assert.equal(sourceWebUrl(source, source.indexOf("?q=")), url);
  assert.equal(sourceWebUrl(source, source.indexOf("after")), undefined);
  assert.equal(
    sourceWebUrl(source, source.indexOf(url), source.indexOf(url) + url.length),
    url,
  );
  assert.equal(sourceWebUrl("not a link", 2), undefined);
  assert.equal(sourceWebUrl("file:///tmp/secret", 0, 18), undefined);
});
