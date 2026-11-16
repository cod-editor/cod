import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execute = promisify(execFile);
export const buildInfoName = "build-info.json";
export const buildOutputs = [
  "main.cjs",
  "preload.cjs",
  "agent-page-preload.cjs",
  "cli.cjs",
  "renderer.js",
  "preview.js",
  "preview.html",
  "preview.css",
  "index.html",
  "styles.css",
  "scrollbars.css",
  "cod-icon.png",
  "xterm.css",
].sort();
const sha = (value) => createHash("sha256").update(value).digest("hex");
export async function git(root, args, limit = 65536) {
  try {
    return (
      await execute("git", ["--no-optional-locks", "-C", root, ...args], {
        timeout: 3000,
        maxBuffer: limit,
      })
    ).stdout.trim();
  } catch {
    return null;
  }
}
export async function checkout(root) {
  const status = await git(root, [
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=normal",
  ]);
  const revision =
    /^# branch\.oid ([a-f0-9]{40,64})$/m.exec(status ?? "")?.[1] ?? null;
  return {
    revision,
    dirty:
      status === null
        ? null
        : status.split("\n").some((line) => line && !line.startsWith("#")),
  };
}
async function entries(directory, limit) {
  const result = [];
  for await (const entry of await opendir(directory)) {
    if (result.length >= limit) throw new Error("identity_limit");
    result.push(entry.name);
  }
  return result.sort();
}
async function hashes(root, roots, limit) {
  const files = [];
  let bytes = 0,
    visited = 0;
  async function visit(name) {
    if (++visited > 4096 || name.split(path.sep).length > 64)
      throw new Error("identity_limit");
    const info = await lstat(path.join(root, name));
    if (info.isSymbolicLink()) throw new Error("unsupported_symlink");
    if (info.isDirectory()) {
      for (const child of await entries(path.join(root, name), 4096 - visited))
        await visit(path.join(name, child));
    } else if (info.isFile()) {
      if (name.endsWith(".map") || name === buildInfoName) return;
      bytes += info.size;
      if (bytes > limit || files.length >= 1024)
        throw new Error("identity_limit");
      files.push(name);
    } else throw new Error("unsupported_input");
  }
  for (const name of roots) await visit(name);
  const result = {};
  let consumed = 0;
  for (const name of files.sort()) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path.join(root, name))) {
      consumed += chunk.length;
      if (consumed > limit) throw new Error("identity_limit");
      hash.update(chunk);
    }
    result[name.split(path.sep).join("/")] = hash.digest("hex");
  }
  return result;
}
export async function sourceHash(root) {
  return sha(
    JSON.stringify(
      await hashes(
        root,
        [
          "src",
          "assets",
          "package.json",
          "package-lock.json",
          "tsconfig.json",
          "scripts/build.mjs",
          "scripts/build-info.mjs",
        ],
        32 * 1024 * 1024,
      ),
    ),
  );
}
export async function outputHashes(root) {
  const names = (await entries(root, 256))
    .filter((n) => !n.endsWith(".map") && n !== buildInfoName)
    .sort();
  if (JSON.stringify(names) !== JSON.stringify(buildOutputs))
    throw new Error("unexpected_build_outputs");
  return hashes(root, buildOutputs, 256 * 1024 * 1024);
}
export async function newBuild(root) {
  const [source, working, manifest] = await Promise.all([
    sourceHash(root),
    checkout(root),
    readFile(path.join(root, "package.json"), "utf8"),
  ]);
  return {
    id: randomUUID(),
    sourceHash: source,
    ...working,
    version: JSON.parse(manifest).version,
  };
}
