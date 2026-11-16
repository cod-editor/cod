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
