// Finite SSH test jobs. No daemon, credentials or public-runner registration.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.join(os.homedir(), ".cod-electron-tests");
const marker = "Cod finite SSH test jobs v1\n";
const maxEvidence = 64 * 1024 * 1024;
const cacheLimit = 2 * 1024 * 1024 * 1024;
export function runPath(id) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))
    throw new Error("Invalid remote run ID");
  return path.join(root, "runs", id);
}
async function json(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function writeJson(file, value) {
  await fs.writeFile(file + ".tmp", JSON.stringify(value, null, 2) + "\n");
  await fs.rename(file + ".tmp", file);
}
export async function verifyManifest(directory, text) {
  const rows = text.trim().split("\n");
  if (!rows.length || rows.length > 20_000)
    throw new Error("Invalid input manifest size");
  for (const row of rows) {
    const match = /^([0-9a-f]{64})  (\.\/.+)$/.exec(row);
    const file = match?.[2];
    if (!file || file.split("/").includes("..") || file.includes("\0"))
      throw new Error("Invalid input manifest path");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path.join(directory, file)))
      hash.update(chunk);
    if (hash.digest("hex") !== match[1])
      throw new Error(`Input identity mismatch: ${file}`);
  }
  return createHash("sha256")
    .update(rows.sort().join("\n") + "\n")
    .digest("hex");
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function retainedRuns() {
  const entries = await fs.readdir(path.join(root, "runs"));
  const completed = [];
  for (const id of entries) {
    if (!/^[0-9a-f-]{36}$/.test(id)) continue;
    const directory = runPath(id);
    const result = await json(path.join(directory, "result.json")).catch(
      () => undefined,
    );
    if (result) completed.push({ id, directory, result });
  }
  completed.sort((a, b) => b.result.finished.localeCompare(a.result.finished));
  for (const old of completed.slice(3)) {
    const pid = Number(
      await fs.readFile(path.join(old.directory, "pid"), "utf8").catch(() => 0),
    );
    if (!alive(pid)) await fs.rm(old.directory, { recursive: true });
  }
  return completed;
}
async function command(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${executable} exited ${signal ?? code}`)),
    );
  });
}
async function ownedCaches(source) {
  const directory = path.join(source, "artifacts/verification");
  await fs.mkdir(directory, { recursive: true });
  for (const name of ["npm", "electron"]) {
    const cache = path.join(root, "cache", name);
    await fs.mkdir(cache, { recursive: true });
    const bytes =
      Number(
        execFileSync("du", ["-sk", cache], { encoding: "utf8" }).split(/\s/)[0],
      ) * 1024;
    if (bytes > cacheLimit) {
      await fs.rm(cache, { recursive: true });
      await fs.mkdir(cache);
    }
    await fs.symlink(cache, path.join(directory, `${name}-cache`));
  }
}
async function collect(directory, frozen) {
  const evidence = path.join(directory, "evidence");
  await fs.mkdir(evidence);
  const log = await fs.open(path.join(directory, "job.log"));
  try {
    const size = (await log.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
    await log.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    await fs.writeFile(path.join(evidence, "run.log"), buffer);
  } finally {
    await log.close();
  }
  let bytes = 0,
    files = 0,
    omitted = 0;
  async function copy(source, relative = "output") {
    for (const entry of await fs
      .readdir(source, { withFileTypes: true })
      .catch(() => [])
      .then((entries) =>
        entries.sort(
          (a, b) =>
            Number(b.name === "preflight.json") -
            Number(a.name === "preflight.json"),
        ),
      )) {
      const file = path.join(source, entry.name),
        next = path.join(relative, entry.name);
      if (entry.isDirectory()) await copy(file, next);
      else if (entry.isFile()) {
        const stat = await fs.stat(file);
        if (files >= 100 || bytes + stat.size > maxEvidence) {
          omitted++;
          continue;
        }
        await fs.mkdir(path.dirname(path.join(evidence, next)), {
          recursive: true,
        });
        await fs.copyFile(file, path.join(evidence, next));
        bytes += stat.size;
        files++;
      }
    }
  }
  if (frozen) {
    await fs.copyFile(
      path.join(frozen, "input-sha256.txt"),
      path.join(evidence, "input-sha256.txt"),
    );
    await copy(path.join(frozen, "output"));
    // Retain bounded evidence, not a second unbounded copy of test artifacts.
    await fs.rm(path.join(frozen, "output"), { recursive: true, force: true });
    const raw = await fs.open(path.join(frozen, "run.log"));
    try {
      const size = (await raw.stat()).size,
        tail = Buffer.alloc(Math.min(size, 1024 * 1024));
      await raw.read(tail, 0, tail.length, Math.max(0, size - tail.length));
      await fs.writeFile(path.join(frozen, "run.log"), tail);
    } finally {
      await raw.close();
    }
  }
  return {
    evidenceBytes: bytes,
    evidenceFiles: files,
    omittedEvidenceFiles: omitted,
  };
}
async function trimOwnedImages(current) {
  const rows = execFileSync(
    "docker",
    [
      "image",
      "ls",
      "--filter",
      "label=cod.finite-test-runner=true",
      "--format",
      "{{.Repository}}:{{.Tag}}",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  const names = [
    ...new Set(
      rows.filter((name) => name.startsWith("cod-test-electron-remote:")),
    ),
  ];
  const keep = new Set([
    current,
    ...names.filter((name) => name !== current).slice(0, 1),
  ]);
  for (const name of names) {
    if (keep.has(name)) continue;
    const used = execFileSync(
      "docker",
      ["ps", "--all", "--filter", `ancestor=${name}`, "--format", "{{.ID}}"],
      { encoding: "utf8" },
    ).trim();
    if (!used)
      execFileSync("docker", ["image", "rm", name], { stdio: "ignore" });
  }
}
async function execute(id) {
  const directory = runPath(id),
    source = path.join(directory, "source");
  await fs.writeFile(path.join(directory, "pid"), String(process.pid));
  const start = process.hrtime.bigint();
  let exitCode = 1,
    error,
    inputIdentity,
    frozen,
    artifacts;
  try {
    const space = await fs.statfs(root);
    if (space.bavail * space.bsize < 6 * 1024 ** 3)
      throw new Error("Insufficient free space for an isolated run");
    await retainedRuns();
    const manifest = await fs.readFile(
      path.join(directory, "expected-sha256.txt"),
      "utf8",
    );
    inputIdentity = await verifyManifest(source, manifest);
    const request = await json(path.join(directory, "request.json"));
    await ownedCaches(source);
    const dockerfile = await fs.readFile(
      path.join(source, "tests/support/electron/Dockerfile"),
    );
    const image =
      "cod-test-electron-remote:" +
      createHash("sha256").update(dockerfile).digest("hex").slice(0, 16);
    try {
      execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    } catch {
      await command(
        "docker",
        [
          "build",
          "--label",
          "cod.finite-test-runner=true",
          "-t",
          image,
          "tests/support/electron",
        ],
        { cwd: source },
      );
    }
    await trimOwnedImages(image);
    try {
      await command(
        path.join(directory, "verify-electron-linux.sh"),
        request.args,
        {
          cwd: source,
          env: {
            ...process.env,
            COD_LINUX_TEST_IMAGE: image,
            COD_TEST_SOURCE_DIR: source,
            ...(request.args[0] === "--ci"
              ? {
                  COD_TEST_FROZEN_REVISION: (
                    await json(path.join(directory, "revision.json"))
                  ).revision,
                  COD_TEST_RUNNER_FILE: path.join(source, "run-electron.sh"),
                  COD_TEST_PREFLIGHT_DRIVER: path.join(
                    source,
                    "run-ci-preflight.mjs",
                  ),
                }
              : {}),
          },
        },
      );
      exitCode = 0;
    } finally {
      const verification = path.join(source, "artifacts/verification");
      const snapshots = (
        await fs.readdir(verification, { withFileTypes: true })
      ).filter(
        (entry) =>
          entry.isDirectory() && /^electron-[A-Za-z0-9]+$/.test(entry.name),
      );
      if (snapshots.length > 1)
        throw new Error("Unexpected extra frozen input");
      frozen = snapshots[0]
        ? path.join(verification, snapshots[0].name)
        : undefined;
      if (frozen) {
        const actual = await verifyManifest(
          path.join(frozen, "input"),
          manifest,
        );
        if (actual !== inputIdentity)
          throw new Error("Frozen input identity differs from accepted source");
      }
      if (exitCode === 0 && !frozen)
        throw new Error("Successful run has no frozen input evidence");
    }
  } catch (caught) {
    error = String(caught);
    exitCode = 1;
  }
  try {
    artifacts = await collect(directory, frozen);
    await fs.copyFile(
      path.join(directory, "evidence/run.log"),
      path.join(directory, "job.log"),
    );
  } catch (caught) {
    error = `${error ?? ""} Evidence collection: ${caught}`;
    exitCode = 1;
  }
  const result = {
    id,
    exitCode,
    inputIdentity,
    error,
    ...artifacts,
    durationMs: Number(process.hrtime.bigint() - start) / 1e6,
    finished: new Date().toISOString(),
  };
  await writeJson(path.join(directory, "result.json"), result);
  await writeJson(path.join(root, "previous-source.json"), { id });
  await retainedRuns();
}
export function recoverableCollection(result, executionCode) {
  return (
    result.exitCode === 1 &&
    executionCode === 0 &&
    /^\s*Evidence collection:/.test(result.error ?? "")
  );
}
async function recoverEvidence(id) {
  const directory = runPath(id),
    original = await json(path.join(directory, "result.json"));
  if (original.exitCode === 0 && original.collectionRecovered) return;
  const verification = path.join(directory, "source/artifacts/verification");
  const names = (await fs.readdir(verification, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() && /^electron-[A-Za-z0-9]+$/.test(entry.name),
    )
    .map((entry) => entry.name);
  if (names.length !== 1)
    throw Error("Recovery requires exactly one owned frozen input");
  const frozen = path.join(verification, names[0]);
  const executionCode = Number(
    (await fs.readFile(path.join(frozen, "exit-code.txt"), "utf8")).trim(),
  );
  if (!recoverableCollection(original, executionCode))
    throw Error(
      "Only collector failures after successful execution can be recovered",
    );
  const manifest = await fs.readFile(
    path.join(directory, "expected-sha256.txt"),
    "utf8",
  );
  if (
    (await verifyManifest(path.join(frozen, "input"), manifest)) !==
    original.inputIdentity
  )
    throw Error("Recovery input identity changed");
  const evidence = path.join(directory, "evidence");
  const request = await json(path.join(directory, "request.json"));
  if (request.args[0] === "--ci") {
    const summary = await json(path.join(evidence, "output/preflight.json"));
    if (
      summary.mode !== "full-ci" ||
      summary.results?.length !== 5 ||
      summary.results.some((group) => group.status !== "PASS")
    )
      throw Error("Full preflight did not pass every group");
  }
  await fs
    .writeFile(
      path.join(directory, "result-before-collection-recovery.json"),
      JSON.stringify(original, null, 2) + "\n",
      { flag: "wx" },
    )
    .catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  const output = path.join(frozen, "output"),
    stat = await fs.lstat(output);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("Recovery output must be an owned directory");
  const dockerfile = await fs.readFile(
    path.join(directory, "source/tests/support/electron/Dockerfile"),
  );
  const image =
    "cod-test-electron-remote:" +
    createHash("sha256").update(dockerfile).digest("hex").slice(0, 16);
  // This bind mount contains only the completed run's output, never host profiles
  // or other jobs. Repair the ownership needed by ordinary bounded cleanup.
  await command("docker", [
    "run",
    "--rm",
    "--mount",
    `type=bind,src=${output},dst=/owned-output`,
    "--entrypoint",
    "chown",
    image,
    "-R",
    `${process.getuid()}:${process.getgid()}`,
    "/owned-output",
  ]);
  await fs.rm(output, { recursive: true });
  let evidenceBytes = 0,
    evidenceFiles = 0;
  async function inventory(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) await inventory(file);
      else if (
        item.isFile() &&
        ![
          path.join(evidence, "run.log"),
          path.join(evidence, "input-sha256.txt"),
        ].includes(file)
      ) {
        evidenceFiles++;
        evidenceBytes += (await fs.stat(file)).size;
      } else if (!item.isFile())
        throw Error("Unexpected recovery evidence type");
    }
  }
  await inventory(evidence);
  if (evidenceFiles > 100 || evidenceBytes > maxEvidence)
    throw Error("Recovery evidence exceeds bounded collection limits");
  await writeJson(path.join(directory, "result.json"), {
    ...original,
    exitCode: executionCode,
    executionExitCode: executionCode,
    error: undefined,
    collectionRecovered: true,
    collectionRecoveredAt: new Date().toISOString(),
    evidenceBytes,
    evidenceFiles,
    omittedEvidenceFiles: null,
  });
}
async function main() {
  const [mode, id] = process.argv.slice(2),
    directory = runPath(id);
  if ((await fs.readFile(path.join(root, ".owner"), "utf8")) !== marker)
    throw new Error("Remote root is not owned by this helper");
  if (mode === "execute") return execute(id);
  if (mode === "recover") {
    await recoverEvidence(id);
    console.log(JSON.stringify({ id, recovered: true }));
    return;
  }
  if (mode === "start") {
    const args = JSON.parse(
      await new Promise((resolve) => {
        let s = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (x) => (s += x));
        process.stdin.on("end", () => resolve(s));
      }),
    );
    if (
      !Array.isArray(args) ||
      args.length > 128 ||
      args.some((x) => typeof x !== "string" || x.length > 4096)
    )
      throw new Error("Invalid test arguments");
    await writeJson(path.join(directory, "request.json"), {
      args,
      accepted: new Date().toISOString(),
    });
    await fs.writeFile(path.join(directory, "job.log"), "", {
      flag: "wx",
      mode: 0o600,
    });
    // SSH session cleanup can kill detached children. A finite transient user unit
    // is owned by the existing user manager, without installing a service.
    execFileSync(
      "systemd-run",
      [
        "--user",
        "--collect",
        "--quiet",
        `--unit=cod-electron-test-${id}`,
        "--property=Type=exec",
        "--property=RuntimeMaxSec=45min",
        "--property=UMask=0077",
        "--property=LimitFSIZE=268435456",
        `--property=StandardOutput=append:${path.join(directory, "job.log")}`,
        `--property=StandardError=append:${path.join(directory, "job.log")}`,
        "flock",
        path.join(root, "active.lock"),
        process.execPath,
        fileURLToPath(import.meta.url),
        "execute",
        id,
      ],
      { stdio: "inherit" },
    );
    console.log(JSON.stringify({ id, accepted: true }));
  } else if (mode === "result") {
    const deadline = Date.now() + 45 * 60 * 1000;
    while (Date.now() < deadline) {
      const result = await json(path.join(directory, "result.json")).catch(
        () => undefined,
      );
      if (result) {
        console.log(JSON.stringify(result));
        return;
      }
      const state = execFileSync(
        "systemctl",
        [
          "--user",
          "show",
          `cod-electron-test-${id}`,
          "--property=ActiveState",
          "--value",
        ],
        { encoding: "utf8" },
      ).trim();
      if (!["active", "activating"].includes(state))
        throw new Error(
          "Worker ended without a result; inspect its retained private job log",
        );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      "Result wait expired; retrieve the same run later without rerunning it",
    );
  } else throw new Error("Unknown worker operation");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
