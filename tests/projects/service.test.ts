import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectService } from "../../src/projects/index.ts";

const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cod-projects-")));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function put(root: string, name: string, text = "fixture\n") {
  const path = join(root, name);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, text);
  return path;
}
async function repo(root: string) {
  await mkdir(root, { recursive: true });
  git(root, "init", "-b", "main");
}
function commit(root: string, message = "fixture") {
  git(root, "add", "--all");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

// Real filesystem and Git calls only. No module mocks or shell execution.
test("AC1: listing and literal search preserve roots, UTF-8 and line numbers; skip ignored/cache/binary/symlink content", async () =>
  fixture(async (root) => {
    const project = join(root, "project space"),
      outside = join(root, "outside");
    await repo(project);
    await mkdir(outside);
    await put(project, "folder/notes ü.md", "first\nNeedle [literal]\nlast\n");
    await put(project, "-leading.txt", "NEEDLE [literal]\n");
    await put(project, ".gitignore", "ignored.txt\n");
    await put(project, "ignored.txt", "needle [literal]");
    for (const dir of ["node_modules", "dist", "build", ".cache"])
      await put(project, `${dir}/hidden.txt`, "needle [literal]");
    await writeFile(
      join(project, "binary.bin"),
      Buffer.from([0, 110, 101, 101, 100, 108, 101]),
    );
    await put(outside, "secret.txt", "needle [literal]");
    await symlink(outside, join(project, "linked-dir"));
    await symlink(join(outside, "secret.txt"), join(project, "linked-file"));
    const service = new ProjectService({ roots: [project] });
    const entries = await service.list();
    assert(
      entries.some(
        (e) =>
          e.name === "folder" && e.kind === "directory" && e.root === project,
      ),
    );
    assert(
      entries.every(
        (e) => e.root === project && e.path === join(project, e.name),
      ),
    );
    const kinds = entries.map((e) => e.kind);
    const firstFile = kinds.indexOf("file");
    if (firstFile >= 0) assert(!kinds.slice(firstFile).includes("directory"));
    const found = await service.search({ query: "needle [literal]" });
    assert.equal(found.truncated, false);
    assert.deepEqual(
      found.matches.map((m) => [m.path, m.line]).sort(),
      [
        [join(project, "folder/notes ü.md"), 2],
        [join(project, "-leading.txt"), 1],
      ].sort(),
    );
    assert(found.matches.every((m) => m.root === project));
    await assert.rejects(async () => service.list(outside));
    await assert.rejects(async () => service.list(join(project, "linked-dir")));
    await assert.rejects(async () => service.search({ query: "" }));
  }));

test("AC1/5: search limit reports incompleteness and resources remain bounded", async () =>
  fixture(async (root) => {
    await put(root, "many.txt", "find me\n".repeat(1200));
    const service = new ProjectService({ roots: [root] });
    const limited = await service.search({ query: "find", maxResults: 2 });
    assert.equal(limited.matches.length, 2);
    assert.equal(limited.truncated, true);
    const defaults = await service.search({ query: "find" });
    assert.equal(defaults.matches.length, 100);
    assert.equal(defaults.truncated, true);
    // Oversized requests must either reject or clamp, never return more than the contractual maximum.
    const oversized = await service
      .search({ query: "find", maxResults: 1001 })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    if ("result" in oversized) {
      assert(oversized.result.matches.length <= 1000);
      assert.equal(oversized.result.truncated, true);
    } else assert(oversized.error instanceof Error);
  }));

test("AC2: multiple repos, nested repo and linked worktree retain independent absolute identities", async () =>
  fixture(async (root) => {
    const a = join(root, "repo a"),
      b = join(root, "repo ü"),
      wt = join(root, "linked worktree");
    for (const p of [a, b]) {
      await repo(p);
      await put(p, "same.txt", "base\n");
      commit(p);
      await put(p, "same.txt", `changed ${p}\n`);
    }
    git(a, "worktree", "add", "-b", "linked", wt);
    await put(wt, "same.txt", "worktree change\n");
    const nested = join(a, "nested");
    await repo(nested);
    await put(nested, "own.txt");
    commit(nested);
    const service = new ProjectService({ roots: [root, a] });
    const discovery = await service.repositories();
    assert.equal(discovery.truncated, false);
    assert.deepEqual(
      discovery.repositories.map((r) => r.root).sort(),
      [a, b, wt, nested].sort(),
    );
    for (const p of [a, b, wt]) {
      const result = await service.changes(p);
      assert.equal(result.repoRoot, p);
      assert(
        result.files.some(
          (f) =>
            f.path === join(p, "same.txt") && f.relativePath === "same.txt",
        ),
      );
    }
  }));

test("AC3: porcelain status handles staged+unstaged, untracked, deleted and renamed paths", async () =>
  fixture(async (root) => {
    await repo(root);
    for (const name of ["both.txt", "deleted.txt", "rename old ü.txt"])
      await put(root, name, "base\n");
    commit(root);
    await put(root, "both.txt", "staged\n");
    git(root, "add", "--", "both.txt");
    await put(root, "both.txt", "unstaged\n");
    await rm(join(root, "deleted.txt"));
    git(root, "mv", "--", "rename old ü.txt", "-renamed new ü.txt");
    await put(root, "untracked space.txt");
    const files = (await new ProjectService({ roots: [root] }).changes(root))
      .files;
    const both = files.find((f) => f.relativePath === "both.txt");
    assert.equal(both?.indexStatus, "M");
    assert.equal(both?.worktreeStatus, "M");
    assert.equal(
      files.find((f) => f.relativePath === "deleted.txt")?.worktreeStatus,
      "D",
    );
    const renamed = files.find((f) => f.relativePath === "-renamed new ü.txt");
    assert.equal(renamed?.indexStatus, "R");
    assert(renamed?.oldPath?.endsWith("rename old ü.txt"));
    const untracked = files.find(
      (f) => f.relativePath === "untracked space.txt",
    );
    assert.equal(untracked?.indexStatus, "?");
    assert.equal(untracked?.worktreeStatus, "?");
  }));

test("AC3: unborn and detached HEAD; configured subdirectory resolves containing repository", async () =>
  fixture(async (root) => {
    await repo(root);
    await put(root, "sub/file.txt", "first\n");
    const service = new ProjectService({ roots: [join(root, "sub")] });
    const unborn = (await service.repositories()).repositories;
    assert.equal(unborn.length, 1);
    assert.equal(unborn[0].root, root);
    assert.equal(unborn[0].head, null);
    git(root, "add", "--all");
    const patch = await service.diff({ repoRoot: root });
    assert(patch.patch.includes("+first"));
    const head = commit(root);
    git(root, "checkout", "--detach", head);
    const detached = (await service.repositories()).repositories[0];
    assert.equal(detached.branch, null);
    assert.equal(detached.head, head);
  }));

test("AC4: working patch covers staged and unstaged; explicit refs compare two trees, not merge base", async () =>
  fixture(async (root) => {
    await repo(root);
    await put(root, "base.txt", "base\n");
    commit(root);
    git(root, "checkout", "-b", "left");
    await put(root, "left-only.txt", "left\n");
    const left = commit(root);
    git(root, "checkout", "main");
    git(root, "checkout", "-b", "right");
    await put(root, "right-only.txt", "right\n");
    const right = commit(root);
    const service = new ProjectService({ roots: [root] });
    const direct = await service.diff({
      repoRoot: root,
      base: "left",
      head: "right",
    });
    assert.equal(direct.base, left);
    assert.equal(direct.head, right);
    assert(direct.patch.includes("-left"));
    assert(direct.patch.includes("+right"));
    await put(root, "staged.txt", "staged content\n");
    git(root, "add", "--", "staged.txt");
    await put(root, "base.txt", "unstaged content\n");
    await put(root, "untracked.txt", "not synthesized\n");
    const working = await service.diff({ repoRoot: root });
    assert.equal(working.base, null);
    assert.equal(working.head, null);
    assert(working.patch.includes("+staged content"));
    assert(working.patch.includes("+unstaged content"));
    assert(!working.patch.includes("not synthesized"));
  }));

test("AC4/5: invalid refs, outside repository and unsafe roots fail without mutations or external diff", async () =>
  fixture(async (root) => {
    const project = join(root, "project"),
      outside = join(root, "outside");
    for (const p of [project, outside]) {
      await repo(p);
      await put(p, "file.txt");
      commit(p);
    }
    const service = new ProjectService({ roots: [project] });
    const before = await readFile(join(project, ".git/config"), "utf8");
    for (const base of [
      "--help",
      "HEAD;touch bad",
      "missing-reference",
      ":file.txt",
    ])
      await assert.rejects(async () =>
        service.diff({ repoRoot: project, base, head: "HEAD" }),
      );
    await assert.rejects(async () =>
      service.diff({ repoRoot: project, base: "HEAD" }),
    );
    await assert.rejects(async () => service.changes(outside));
    await assert.rejects(async () => service.diff({ repoRoot: outside }));
    assert.equal(await readFile(join(project, ".git/config"), "utf8"), before);
    // A repository-local external diff command must never execute.
    git(
      project,
      "config",
      "diff.external",
      "/definitely/nonexistent/cod-external-diff",
    );
    await put(project, "file.txt", "changed\n");
    const diff = await service.diff({ repoRoot: project });
    assert(diff.patch.includes("+changed"));
    await assert.rejects(async () =>
      new ProjectService({ roots: ["relative"] }).list(),
    );
  }));

test("AC5: patch output cannot exceed 8 MiB without an explicit bound signal", async () =>
  fixture(async (root) => {
    await repo(root);
    await put(root, "large.txt", "base\n");
    commit(root);
    await put(root, "large.txt", "changed fixture line\n".repeat(500_000));
    const service = new ProjectService({ roots: [root] });
    const outcome = await service.diff({ repoRoot: root }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    if ("result" in outcome) {
      assert.equal(outcome.result.truncated, true);
      assert(
        Buffer.byteLength(outcome.result.patch, "utf8") <= 8 * 1024 * 1024,
      );
    } else {
      assert(outcome.error instanceof Error);
      assert.match(
        outcome.error.message,
        /limit|large|bound|buffer|size|exceed|truncat/i,
      );
    }
  }));

test("review regression: inherited repository environment cannot redirect discovery or authorize outside repository", async () =>
  fixture(async (root) => {
    const project = join(root, "inside"),
      outside = join(root, "outside");
    for (const dir of [project, outside]) {
      await repo(dir);
      await put(dir, "file.txt");
      commit(dir);
    }
    const oldDir = process.env.GIT_DIR,
      oldTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(outside, ".git");
    process.env.GIT_WORK_TREE = outside;
    try {
      const service = new ProjectService({ roots: [project] });
      assert.deepEqual(
        (await service.repositories()).repositories.map((r) => r.root),
        [project],
      );
      await assert.rejects(() => service.changes(outside));
      assert.equal((await service.changes(project)).repoRoot, project);
    } finally {
      if (oldDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = oldDir;
      if (oldTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = oldTree;
    }
  }));

test("review regression: repository paths preserve trailing spaces and explicit listing refuses internal symlink traversal", async () =>
  fixture(async (root) => {
    const project = join(root, "trailing space ");
    await repo(project);
    await put(project, "nested/inner/file.txt");
    commit(project);
    const service = new ProjectService({ roots: [project] });
    assert.deepEqual(
      (await service.repositories()).repositories.map((r) => r.root),
      [project],
    );
    await symlink(join(project, "nested"), join(project, "alias"));
    await symlink(project, join(project, "self"));
    await assert.rejects(() => service.list(join(project, "alias")));
    await assert.rejects(() => service.list(join(project, "alias/inner")));
    await assert.rejects(() => service.list(join(project, "self")));
    assert.equal(
      (await service.list(join(project, "nested/inner")))[0].name,
      "file.txt",
    );
  }));
