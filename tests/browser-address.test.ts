import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAddress, localFileAddress } from "../src/browser/address.ts";

test("Address input recognizes websites and local development servers", () => {
  for (const [input, expected] of [
    [" example.com/docs?q=a#b ", "https://example.com/docs?q=a#b"],
    ["https://example.com", "https://example.com/"],
    ["localhost:3000/path", "http://localhost:3000/path"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080/"],
    ["[::1]:8080", "http://[::1]:8080/"],
    ["about:blank", "about:blank"],
    ["пример.рф", "https://xn--e1afmkfd.xn--p1ai/"],
  ])
    assert.equal(resolveAddress(input).url, expected);
});

test("Only a bare non-loopback host gets an HTTP fallback destination", () => {
  assert.deepEqual(resolveAddress(" example.com:443/path?q=x#fragment "), {
    url: "https://example.com/path?q=x#fragment",
    httpFallbackUrl: "http://example.com:443/path?q=x#fragment",
  });
  for (const input of [
    "https://example.com/",
    "http://example.com/",
    "localhost:3000/",
    "[::1]:8080",
    "a search query",
    "file:///tmp/demo.html",
  ])
    assert.equal(resolveAddress(input).httpFallbackUrl, undefined);
});

test("Search encodes text and operators without navigating or executing them", () => {
  for (const query of [
    "яндекс музыка",
    "site:example.com hello",
    "a & b # c",
    "weather",
  ])
    assert.equal(
      new URL(resolveAddress(query).url).searchParams.get("q"),
      query,
    );
  for (const input of [
    "",
    "  ",
    "javascript:alert(1)",
    "file://remote-server/tmp/x",
    "data:text/html,hello",
    "ftp://example.com",
  ])
    assert.throws(() => resolveAddress(input));
});

test("Local file addresses preserve native filename punctuation", () => {
  assert.equal(
    localFileAddress("/tmp/отчёт #1%?.html"),
    "file:///tmp/%D0%BE%D1%82%D1%87%D1%91%D1%82%20%231%25%3F.html",
  );
  assert.equal(
    resolveAddress("file:///tmp/report%20one.html").url,
    "file:///tmp/report%20one.html",
  );
  assert.equal(
    localFileAddress("C:\\reports\\one.html"),
    "file:///C:/reports/one.html",
  );
});
