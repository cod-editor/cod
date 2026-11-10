import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareExtension } from "../../src/extension-install.ts";

test("release paths and changed payloads keep one installation identity without touching storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cod-extension-install-"));
  try {
    const directory = path.join(root, "profile/addons");
    const manifest =
      '{"manifest_version":3,"name":"Fixture","version":"2026.10.2"}\n';
    for (const name of ["release-a", "release-b"]) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, "manifest.json"), manifest);
      await writeFile(path.join(root, name, "payload.js"), name);
    }
    const first = await prepareExtension(
      path.join(root, "release-a"),
      directory,
    );
    await mkdir(path.join(root, "profile/storage"));
    await writeFile(
      path.join(root, "profile/storage/untouched"),
      "opaque fixture",
    );
    const second = await prepareExtension(
      path.join(root, "release-b"),
      directory,
    );
    assert.equal(second, first);
    assert.equal(
      await readFile(path.join(second, "manifest.json"), "utf8"),
      manifest,
    );
    assert.equal(
      await readFile(path.join(second, "payload.js"), "utf8"),
      "release-b",
    );
    assert.equal(
      await readFile(path.join(root, "profile/storage/untouched"), "utf8"),
      "opaque fixture",
    );
    assert.deepEqual(await readdir(directory), ["bitwarden"]);
    await symlink(
      path.join(root, "release-a/payload.js"),
      path.join(root, "release-a/link"),
    );
    await assert.rejects(
      prepareExtension(path.join(root, "release-a"), directory),
      /symlinks/,
    );
    assert.equal(
      await readFile(path.join(second, "payload.js"), "utf8"),
      "release-b",
    );
    await assert.rejects(
      prepareExtension(path.join(root, "missing"), directory),
    );
    assert.equal(
      await readFile(path.join(second, "payload.js"), "utf8"),
      "release-b",
    );
    assert.equal(await prepareExtension(second, directory), second);
    await symlink(
      path.join(root, "release-b/payload.js"),
      path.join(second, "link"),
    );
    await assert.rejects(prepareExtension(second, directory), /symlinks/);
    assert.equal(
      await readFile(path.join(root, "profile/storage/untouched"), "utf8"),
      "opaque fixture",
    );
    await rm(path.join(second, "link"));
    await rename(second, path.join(directory, ".bitwarden-previous"));
    assert.equal(
      await prepareExtension(path.join(root, "release-b"), directory),
      first,
    );
    assert.equal(
      await readFile(path.join(first, "payload.js"), "utf8"),
      "release-b",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
