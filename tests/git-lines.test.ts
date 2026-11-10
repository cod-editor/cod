import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { changedLines } from "../src/git-lines.ts";
test("Git-generated hunks preserve header-looking added text and quoted Unicode file identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cod-lines-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
  try {
    git("init", "-q");
    const file = path.join(root, 'quoted "é.txt');
    await writeFile(file, "old\n");
    git("add", "--all");
    git("commit", "-qm", "Fixture baseline");
    await writeFile(file, "++ header-looking content\nnext\n");
    const patch = git("diff", "--src-prefix=a/", "--dst-prefix=b/");
    assert.deepEqual(changedLines(patch, root, file), [1, 2]);
    assert.deepEqual(
      changedLines(patch, root, path.join(root, "other.txt")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
