import {
  lstat,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Inspect executable paths only, never process arguments or environment values.
export async function runningExecutables() {
  if (process.platform === "darwin") {
    const { stdout } = await promisify(execFile)(
      "/bin/ps",
      ["-ww", "-axo", "comm="],
      {
        timeout: 10000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const paths = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => path.isAbsolute(line));
    if (!paths.length) throw new Error("No executable paths available");
    return paths;
  }
  if (process.platform === "linux") {
    const paths = [];
    for (const pid of (await readdir("/proc")).filter((name) =>
      /^\d+$/.test(name),
    )) {
      try {
        paths.push(await readlink(`/proc/${pid}/exe`));
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
      }
    }
    if (!paths.length) throw new Error("No executable paths available");
    return paths;
  }
  throw new Error("Executable detection unavailable on this platform");
}

// Only prune timestamped packages for the successfully published target.
// Other targets, staging directories, symlinks and arbitrary release files stay.
export async function pruneOlderPackages(
  destination,
  detectRunning = runningExecutables,
) {
  const match = /^cod-(darwin|linux)-(arm64|x64)-(\d+)$/.exec(
    path.basename(destination),
  );
  if (!match || !(await lstat(destination)).isDirectory())
    throw new Error("Expected an existing generated package directory");
  const [, platform, arch, timestamp] = match;
  const directory = path.dirname(destination);
  const pattern = new RegExp(`^cod-${platform}-${arch}-(\\d+)$`);
  const removed = [];
  let running;
  try {
    const detected = await detectRunning();
    if (
      !Array.isArray(detected) ||
      detected.some(
        (file) => typeof file !== "string" || !path.isAbsolute(file),
      )
    )
      throw new Error("Invalid executable paths");
    running = await Promise.all(
      detected.map(async (file) => {
        try {
          return await realpath(file);
        } catch {
          return path.resolve(file);
        }
      }),
    );
  } catch {
    console.warn(
      "Could not determine running packages; retained previous releases.",
    );
    return removed;
  }
  const canonicalDirectory = await realpath(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = pattern.exec(entry.name);
    if (
      !entry.isDirectory() ||
      !candidate ||
      BigInt(candidate[1]) >= BigInt(timestamp)
    )
      continue;
    const packagePaths = [
      path.join(canonicalDirectory, entry.name),
      path.resolve(directory, entry.name),
    ];
    if (
      running.some((file) =>
        packagePaths.some(
          (packagePath) =>
            file === packagePath || file.startsWith(packagePath + path.sep),
        ),
      )
    )
      continue;
    await rm(path.join(directory, entry.name), {
      recursive: true,
      force: true,
    });
    removed.push(entry.name);
  }
  return removed;
}

export async function publishPackage(
  output,
  destination,
  prepare = async () => {},
  detectRunning = runningExecutables,
) {
  // Signing/validation must succeed while staged before any previous release is removed.
  await prepare(output);
  await rename(output, destination);
  await pruneOlderPackages(destination, detectRunning);
}
