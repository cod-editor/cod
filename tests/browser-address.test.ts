import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAddress } from "../src/browser/address.ts";

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
    assert.equal(resolveAddress(input), expected);
});

test("Search encodes text and operators without navigating or executing them", () => {
  for (const query of [
    "яндекс музыка",
    "site:example.com hello",
    "a & b # c",
    "weather",
  ])
    assert.equal(new URL(resolveAddress(query)).searchParams.get("q"), query);
  for (const input of [
    "",
    "  ",
    "javascript:alert(1)",
    "file:///tmp/x",
    "data:text/html,hello",
    "ftp://example.com",
  ])
    assert.throws(() => resolveAddress(input));
});
