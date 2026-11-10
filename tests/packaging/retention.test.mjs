import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  publishPackage,
  pruneOlderPackages,
} from "../../scripts/release-retention.mjs";

test("successful publication prunes only older generated packages of the same target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cod-retention-"));
  try {
    const keep = [
      "cod-linux-arm64-1",
      "cod-darwin-x64-1",
      "cod-darwin-arm64-checkpoint-1",
      ".cod-stage-active",
      "cod-darwin-arm64-300",
    ];
    for (const name of [...keep, "cod-darwin-arm64-100", ".cod-stage-current"])
      await mkdir(path.join(root, name));
    await writeFile(path.join(root, "notes.txt"), "unrelated");
    await symlink(
      path.join(root, ".cod-stage-active"),
      path.join(root, "cod-darwin-arm64-99"),
    );
    const output = path.join(root, ".cod-stage-current/artifact");
    await mkdir(output);
    await publishPackage(
      output,
      path.join(root, "cod-darwin-arm64-200"),
      async (staged) => {
        assert.ok((await readdir(root)).includes("cod-darwin-arm64-100"));
        await writeFile(path.join(staged, "signed"), "yes");
      },
      async () => [],
    );
    assert.deepEqual(
      (await readdir(root)).sort(),
      [
        ...keep,
        ".cod-stage-current",
        "notes.txt",
        "cod-darwin-arm64-99",
        "cod-darwin-arm64-200",
      ].sort(),
    );
    await assert.rejects(pruneOlderPackages(path.join(root, "missing")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed signing leaves the previous package and unrelated staging intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cod-retention-failure-"));
  try {
    for (const name of [
      "cod-darwin-arm64-100",
      ".cod-stage-active",
      ".cod-stage-current",
    ])
      await mkdir(path.join(root, name));
    const before = await readdir(root);
    await assert.rejects(
      publishPackage(
        path.join(root, ".cod-stage-current"),
        path.join(root, "cod-darwin-arm64-200"),
        async () => {
          throw new Error("signing failed");
        },
      ),
      /signing failed/,
    );
    assert.deepEqual(await readdir(root), before);
    await assert.rejects(
      publishPackage(
        path.join(root, "missing-output"),
        path.join(root, "cod-darwin-arm64-200"),
      ),
    );
    assert.deepEqual(await readdir(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("running packages survive pruning until exit and unknown detection preserves all", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cod-retention-running-"));
  try {
    const old = path.join(root, "cod-darwin-arm64-100");
    const latest = path.join(root, "cod-darwin-arm64-200");
    await mkdir(old);
    await mkdir(latest);
    const executable = path.join(old, "Cod.app/Contents/MacOS/Electron");
    assert.deepEqual(
      await pruneOlderPackages(latest, async () => [executable]),
      [],
    );
    assert.ok((await readdir(root)).includes(path.basename(old)));
    assert.deepEqual(
      await pruneOlderPackages(latest, async () => {
        throw new Error("process listing denied");
      }),
      [],
    );
    assert.ok((await readdir(root)).includes(path.basename(old)));
    assert.deepEqual(await pruneOlderPackages(latest, async () => []), [
      path.basename(old),
    ]);
    assert.deepEqual(await readdir(root), [path.basename(latest)]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "real executable detection protects a live packaged process",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "cod-retention-process-"),
    );
    let child;
    try {
      const old = path.join(root, "cod-darwin-arm64-100");
      const latest = path.join(root, "cod-darwin-arm64-200");
      await mkdir(old);
      await mkdir(latest);
      const executable = path.join(old, "fixture runner");
      await cp("/bin/sleep", executable);
      child = spawn(executable, ["60"], { stdio: "ignore" });
      await once(child, "spawn");
      assert.deepEqual(await pruneOlderPackages(latest), []);
      assert.ok((await readdir(root)).includes(path.basename(old)));
      const exit = once(child, "exit");
      child.kill();
      await exit;
      child = undefined;
      assert.deepEqual(await pruneOlderPackages(latest), [path.basename(old)]);
    } finally {
      child?.kill();
      await rm(root, { recursive: true, force: true });
    }
  },
);
