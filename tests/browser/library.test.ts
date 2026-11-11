import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserLibrary } from "../../src/browser/library.ts";
import { resolveAddress } from "../../src/browser/address.ts";
test("Local history, deletion and search settings persist without retaining authentication callbacks", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cod-browser-library-"));
  try {
    const library = new BrowserLibrary(dir);
    await library.visit(
      "https://example.invalid/docs#heading",
      "Documentation",
    );
    await library.visit(
      "https://example.invalid/oauth/callback?code=secret",
      "Login",
    );
    await library.visit("https://user:pass@example.invalid/", "Private");
    await library.visit(
      "https://example.invalid/docs",
      "Updated documentation",
    );
    assert.equal((await library.history()).length, 1);
    assert.equal(
      (await library.history("updated docs"))[0].title,
      "Updated documentation",
    );
    await library.configure("duckduckgo");
    const restored = new BrowserLibrary(dir);
    assert.equal((await restored.settings()).searchEngine, "duckduckgo");
    assert.equal(
      resolveAddress("two words", "duckduckgo"),
      "https://duckduckgo.com/?q=two%20words",
    );
    assert.equal(
      resolveAddress("example.invalid", "yandex"),
      "https://example.invalid/",
    );
    await assert.rejects(restored.configure("invalid"));
    assert.equal(
      (await stat(path.join(dir, "browser-library.json"))).mode & 0o077,
      0,
    );
    await restored.forget("https://example.invalid/docs");
    assert.deepEqual(await new BrowserLibrary(dir).history(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
