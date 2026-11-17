import { test } from "node:test";
import assert from "node:assert/strict";
import { lsofDirectory, terminalDirectory } from "../../src/terminals/cwd.ts";

test("lsof preserves UTF-8, spaces, control characters and literal backslashes", () => {
  assert.equal(
    lsofDirectory(Buffer.from("p123\0\nfcwd\0n/tmp/folder with \u03b1\0\n")),
    "/tmp/folder with \u03b1",
  );
  assert.equal(
    lsofDirectory(Buffer.from("p123\0\nfcwd\0n/tmp/line\\nnext\\tpart\0\n")),
    "/tmp/line\nnext\tpart",
  );
  assert.equal(
    lsofDirectory(Buffer.from("n/tmp/literal\\\\n\\\\name\0")),
    "/tmp/literal\\n\\name",
  );
  assert.equal(lsofDirectory(Buffer.from("n/tmp/\\xce\\xb1\0")), "/tmp/\u03b1");
});
test("missing, ambiguous or invalid cwd fields fail rather than guess a directory", () => {
  for (const data of [
    "p123\0",
    "n/tmp/a\0n/tmp/b\0",
    "nrelative\0",
    "n/tmp/\\x00\0",
    "n/tmp/\\q\0",
    "n/tmp/\\xff\0",
  ])
    assert.throws(() => lsofDirectory(Buffer.from(data)));
});
test(
  "live Linux process lookup reads the actual owned process directory",
  { skip: process.platform !== "linux" },
  async () => {
    assert.equal(await terminalDirectory(process.pid), process.cwd());
    await assert.rejects(() => terminalDirectory(0));
  },
);
