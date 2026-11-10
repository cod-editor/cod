import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const metadataName = "profile-migration.json";
function info(file: string) {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function assertDirectory(directory: string): void {
  const entry = info(directory);
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
    throw new Error(
      `Profile migration requires a real directory: ${directory}`,
    );
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}
/** No protocol request or account data is read: only socket availability and lock owner. */
export function profileIsLive(directory: string): boolean {
  const socket = path.join(directory, "cod.sock");
  if (info(socket)) {
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        `const net=require('node:net'); const s=net.connect(process.argv[1]); const t=setTimeout(()=>process.exit(2),700); s.on('connect',()=>{clearTimeout(t);s.destroy();process.exit(0)});s.on('error',e=>{clearTimeout(t);process.exit(['ENOENT','ECONNREFUSED'].includes(e.code)?1:2)});`,
        socket,
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: "ignore",
        timeout: 1200,
      },
    );
    if (probe.status !== 1) return true;
  }
  for (const lock of [
    path.join(directory, "SingletonLock"),
    path.join(directory, "chromium", "SingletonLock"),
  ]) {
    const entry = info(lock);
    if (entry) {
      if (!entry.isSymbolicLink()) return true;
      const match = /^(.*)-(\d+)$/.exec(readlinkSync(lock));
      if (!match || match[1] !== os.hostname()) return true;
      if (processAlive(Number(match[2]))) return true;
    }
  }
  return false;
}
interface MigrationRecord {
  version: 1;
  legacyDirectory: string;
  directory: string;
  owner: number;
  extensionDirectory?: string;
  cacheArchive?: string;
}
export interface ProfileMigrationOptions {
  legacyDirectory: string;
  directory: string;
  probeLive?: (directory: string) => boolean;
  /** Deterministic interruption injection for isolated filesystem tests. */
  checkpoint?: (
    step: "cache-archived" | "renamed" | "payload-restored",
  ) => void;
}
const conflictMessage =
  "Cod found two saved workspace profiles and could not safely restore your data. Your data has not been changed.";
const chromiumCacheEntries = new Set([
  "Cache",
  "Code Cache",
  "DIPS",
  "DIPS-wal",
  "DIPS-shm",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "DevToolsActivePort",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "Local Storage",
  "Local State",
  "Network",
  "Network Persistent State",
  "Preferences",
  "Secure Preferences",
  "Session Storage",
  "Shared Dictionary",
  "SharedStorage",
  "SharedStorage-wal",
  "SharedStorage-shm",
  "Trust Tokens",
  "Trust Tokens-journal",
  "blob_storage",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "Crashpad",
  "Crash Reports",
  "Last Version",
  "IndexedDB",
  "Service Worker",
]);
function incidentalChromiumDirectory(directory: string): boolean {
  return readdirSync(directory).every((name) => chromiumCacheEntries.has(name));
}
/** Caller holds the application OS singleton lock, including crash recovery. */
export function migrateProfile(options: ProfileMigrationOptions): string {
  const directory = path.resolve(options.directory),
    legacyDirectory = path.resolve(options.legacyDirectory);
  if (directory === legacyDirectory) return directory;
  assertDirectory(directory);
  assertDirectory(legacyDirectory);
  const journal = `${directory}.migration.json`;
  const finished = path.join(directory, metadataName);
  const probe = options.probeLive ?? profileIsLive;
  let record: MigrationRecord;
  if (info(journal)) {
    if (info(journal)!.isSymbolicLink())
      throw new Error("Profile migration journal must not be a symlink");
    record = JSON.parse(readFileSync(journal, "utf8")) as MigrationRecord;
    if (
      record.version !== 1 ||
      record.directory !== directory ||
      record.legacyDirectory !== legacyDirectory
    )
      throw new Error(
        "Profile migration journal does not match requested paths",
      );
    if (record.owner !== process.pid && processAlive(record.owner))
      throw new Error("Another Cod profile migration is in progress");
    if (probe(legacyDirectory) || probe(directory))
      throw new Error("Close the running Cod before migrating its profile");
  } else {
    if (info(finished)) {
      if (info(finished)!.isSymbolicLink())
        throw new Error("Profile migration metadata must not be a symlink");
      const saved = JSON.parse(
        readFileSync(finished, "utf8"),
      ) as MigrationRecord;
      if (
        saved.version !== 1 ||
        saved.directory !== directory ||
        saved.legacyDirectory !== legacyDirectory
      )
        throw new Error(
          "Profile migration metadata does not match requested paths",
        );
      if (
        info(legacyDirectory) &&
        readdirSync(legacyDirectory).some(
          (name) => !["browser-addons", "cod.sock"].includes(name),
        )
      )
        throw new Error(conflictMessage);
      return directory;
    }
    if (!info(legacyDirectory)) return directory;
    if (probe(legacyDirectory))
      throw new Error("Close the running Cod before migrating its profile");
    record = { version: 1, legacyDirectory, directory, owner: process.pid };
    if (info(directory)) {
      if (probe(directory))
        throw new Error("Close the running Cod before restoring your data.");
      if (readdirSync(directory).length) {
        if (!incidentalChromiumDirectory(directory))
          throw new Error(conflictMessage);
        record.cacheArchive = path.join(
          path.dirname(directory),
          `Cod-recovery-${Date.now()}-${randomUUID()}`,
        );
      } else rmdirSync(directory);
    }
    mkdirSync(path.dirname(directory), { recursive: true });
    writeFileSync(journal, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  }
  if (record.cacheArchive) {
    if (
      path.dirname(record.cacheArchive) !== path.dirname(directory) ||
      !/^Cod-recovery-\d+-[a-f0-9-]+$/.test(path.basename(record.cacheArchive))
    )
      throw new Error("Invalid profile recovery location");
    if (!info(record.cacheArchive)) {
      if (!info(directory) || !incidentalChromiumDirectory(directory))
        throw new Error(
          "Profile recovery contents changed; no data was overwritten.",
        );
      renameSync(directory, record.cacheArchive);
      options.checkpoint?.("cache-archived");
    }
  }
  if (!info(directory)) {
    renameSync(legacyDirectory, directory);
    options.checkpoint?.("renamed");
  }
  // Chromium derives an unkeyed extension ID from its real install path. Keep
  // executable payload at that exact legacy path; browser storage moves intact.
  const newAddons = path.join(directory, "browser-addons");
  const oldAddons = path.join(legacyDirectory, "browser-addons");
  for (const name of [
    "bitwarden",
    ".bitwarden-previous",
    ".bitwarden-install",
  ]) {
    const source = path.join(newAddons, name),
      destination = path.join(oldAddons, name);
    if (!info(source)) continue;
    assertDirectory(newAddons);
    assertDirectory(source);
    assertDirectory(legacyDirectory);
    assertDirectory(oldAddons);
    mkdirSync(oldAddons, { recursive: true, mode: 0o700 });
    if (info(destination))
      throw new Error(
        "Legacy extension path already exists; refusing to overwrite it",
      );
    renameSync(source, destination);
  }
  if (
    info(path.join(oldAddons, "bitwarden")) ||
    info(path.join(oldAddons, ".bitwarden-previous"))
  )
    record.extensionDirectory = oldAddons;
  options.checkpoint?.("payload-restored");
  // Existing external CLI contexts may still carry the old socket path.
  if (process.platform !== "win32") {
    mkdirSync(legacyDirectory, { recursive: true, mode: 0o700 });
    const oldSocket = path.join(legacyDirectory, "cod.sock");
    if (!info(oldSocket))
      symlinkSync(path.join(directory, "cod.sock"), oldSocket);
  }
  writeFileSync(finished, JSON.stringify(record), { mode: 0o600 });
  unlinkSync(journal);
  return directory;
}
export function extensionInstallDirectory(directory: string): string {
  const marker = path.join(directory, metadataName);
  if (!existsSync(marker)) return path.join(directory, "browser-addons");
  const record = JSON.parse(readFileSync(marker, "utf8")) as MigrationRecord;
  if (record.version !== 1 || record.directory !== path.resolve(directory))
    throw new Error("Invalid profile migration metadata");
  const expected = path.join(record.legacyDirectory, "browser-addons");
  if (record.extensionDirectory && record.extensionDirectory !== expected)
    throw new Error("Invalid legacy extension installation path");
  return record.extensionDirectory ?? path.join(directory, "browser-addons");
}
