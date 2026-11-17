import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runPath,
  verifyManifest,
  recoverableCollection,
} from "../../scripts/remote-electron-worker.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
test("Remote result identities reject traversal and detect changed source bytes", async () => {
  for (const id of [
    "../other",
    "-option",
    "",
    "00000000-0000-0000-0000-00000000000/other",
  ])
    assert.throws(() => runPath(id), /Invalid remote run ID/);
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-remote-input-"));
  try {
    await writeFile(path.join(directory, "fixture.txt"), "accepted input\n");
    const manifest = `${hash("accepted input\n")}  ./fixture.txt\n`;
    assert.match(await verifyManifest(directory, manifest), /^[0-9a-f]{64}$/);
    await writeFile(path.join(directory, "fixture.txt"), "later input\n");
    await assert.rejects(
      verifyManifest(directory, manifest),
      /Input identity mismatch/,
    );
    await assert.rejects(
      verifyManifest(directory, `${hash("x")}  ./../other\n`),
      /Invalid input manifest path/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Freeze-only copies uncommitted input, excludes private artifacts and never invokes Docker", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-freeze-"));
  try {
    for (const name of [
      "package.json",
      "package-lock.json",
      "playwright.config.ts",
      "tsconfig.json",
    ])
      await writeFile(path.join(directory, name), "invented fixture\n");
    for (const name of [
      "src",
      "scripts",
      "tests/support/electron",
      "runtime-skills",
      "runtime-plugins",
      "assets",
      "bin",
    ])
      await mkdir(path.join(directory, name), { recursive: true });
    for (const name of ["run.sh", "check-sandbox.mjs"])
      await writeFile(
        path.join(directory, "tests/support/electron", name),
        "invented runner fixture\n",
      );
    await writeFile(path.join(directory, "src", "uncommitted.txt"), "before\n");
    await writeFile(
      path.join(directory, "src", ".env.local"),
      "PRIVATE_FIXTURE\n",
    );
    await mkdir(path.join(directory, "src", "reports"));
    await writeFile(
      path.join(directory, "src", "reports", "private.txt"),
      "PRIVATE_FIXTURE\n",
    );
    await writeFile(
      path.join(directory, "bin", "docker"),
      "#!/bin/sh\nexit 99\n",
      { mode: 0o755 },
    );
    const script = fileURLToPath(
      new URL("../../scripts/verify-electron-linux.sh", import.meta.url),
    );
    const output = execFileSync(script, ["--freeze-only"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: path.join(directory, "bin") + path.delimiter + process.env.PATH,
        COD_TEST_SOURCE_DIR: directory,
      },
    });
    const frozen = /^Frozen input and evidence: (.+)$/m.exec(output)?.[1];
    assert.ok(
      frozen?.startsWith(
        path.join(directory, "artifacts/verification") + path.sep,
      ),
    );
    await writeFile(path.join(directory, "src", "uncommitted.txt"), "after\n");
    assert.equal(
      await readFile(path.join(frozen, "input/src/uncommitted.txt"), "utf8"),
      "before\n",
    );
    assert.deepEqual(await readdir(path.join(frozen, "input/src")), [
      "uncommitted.txt",
    ]);
    const manifest = await readFile(
      path.join(frozen, "input-sha256.txt"),
      "utf8",
    );
    assert.ok(manifest.includes(`${hash("before\n")}  ./src/uncommitted.txt`));
    await verifyManifest(path.join(frozen, "input"), manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Full preflight mirrors Check job commands and does not skip later shards after a failure", async () => {
  const { groups, validateWorkflow, executeGroups } =
    await import("../../scripts/ci-preflight.mjs");
  const workflow = await readFile(
    new URL("../../.github/workflows/check.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotThrow(() => validateWorkflow(workflow));
  assert.throws(
    () =>
      validateWorkflow(workflow.replace("shard: [1, 2, 3]", "shard: [1, 2]")),
    /workflow changed/,
  );
  assert.throws(
    () =>
      validateWorkflow(workflow + "      - run: npm run new-required-check\n"),
    /workflow changed/,
  );
  const seen = [];
  const results = await executeGroups(async (group) => {
    seen.push(group.name);
    if (group.name === "Electron shard 2/3")
      throw Error("invented shard failure");
  });
  assert.deepEqual(
    seen,
    groups.map((group) => group.name),
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ["PASS", "PASS", "PASS", "FAIL", "PASS"],
  );
  const onlyFast = [];
  const failedFast = await executeGroups(async (group) => {
    onlyFast.push(group.name);
    throw Error("invented fast failure");
  });
  assert.deepEqual(onlyFast, ["Fast checks"]);
  assert.deepEqual(
    failedFast.map((result) => result.status),
    ["FAIL", "SKIP", "SKIP", "SKIP", "SKIP"],
  );
});

test("Full freeze captures the clean committed tree including workflow and docs, and refuses later edits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-full-freeze-"));
  const git = (...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
    }).trim();
  try {
    await mkdir(path.join(directory, "tests/support/electron"), {
      recursive: true,
    });
    await mkdir(path.join(directory, "scripts"));
    await mkdir(path.join(directory, ".github/workflows"), { recursive: true });
    await mkdir(path.join(directory, "docs"));
    await writeFile(path.join(directory, ".gitignore"), "artifacts/\n.env\n");
    await writeFile(path.join(directory, "README.md"), "committed docs\n");
    await writeFile(path.join(directory, "docs/usage.md"), "committed guide\n");
    await writeFile(
      path.join(directory, ".github/workflows/check.yml"),
      "committed CI\n",
    );
    await writeFile(
      path.join(directory, "scripts/ci-preflight.mjs"),
      "invented driver\n",
    );
    for (const name of ["run.sh", "check-sandbox.mjs"])
      await writeFile(
        path.join(directory, "tests/support/electron", name),
        "invented runner\n",
      );
    git("init", "--quiet");
    git("config", "user.name", "Invented fixture");
    git("config", "user.email", "fixture@example.invalid");
    git(
      "add",
      "README.md",
      "docs",
      ".github",
      ".gitignore",
      "scripts",
      "tests",
    );
    git("commit", "-qm", "Create invented preflight source");
    await writeFile(path.join(directory, ".env"), "PRIVATE_FIXTURE");
    const script = fileURLToPath(
      new URL("../../scripts/verify-electron-linux.sh", import.meta.url),
    );
    const freeze = () =>
      execFileSync(script, ["--freeze-only", "--ci"], {
        encoding: "utf8",
        env: { ...process.env, COD_TEST_SOURCE_DIR: directory },
      });
    const frozen = /^Frozen input and evidence: (.+)$/m.exec(freeze())?.[1];
    assert.equal(
      JSON.parse(await readFile(path.join(frozen, "revision.json"), "utf8"))
        .revision,
      git("rev-parse", "HEAD"),
    );
    assert.equal(
      await readFile(path.join(frozen, "input/docs/usage.md"), "utf8"),
      "committed guide\n",
    );
    assert.equal(
      await readFile(
        path.join(frozen, "input/.github/workflows/check.yml"),
        "utf8",
      ),
      "committed CI\n",
    );
    assert.ok(!(await readdir(path.join(frozen, "input"))).includes(".env"));
    await writeFile(path.join(directory, "README.md"), "later edit\n");
    assert.throws(freeze, /Commit the final source/);
    assert.equal(
      await readFile(path.join(frozen, "input/README.md"), "utf8"),
      "committed docs\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Evidence recovery cannot relabel failed execution or an unrelated runner failure as passing", () => {
  const failed = { exitCode: 1, error: " Evidence collection: Error: EACCES" };
  assert.equal(recoverableCollection(failed, 0), true);
  assert.equal(recoverableCollection(failed, 1), false);
  assert.equal(
    recoverableCollection(
      { exitCode: 1, error: "Test command failed Evidence collection: EACCES" },
      0,
    ),
    false,
  );
  assert.equal(recoverableCollection({ exitCode: 0 }, 0), false);
});
