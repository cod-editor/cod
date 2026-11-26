import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  installedReleaseIncludes,
  releaseImage,
  type ReleaseUpdate,
} from "./release-update.ts";

export interface ReleaseInstallDesktop {
  quarantine(image: string, downloadUrl: string): Promise<void>;
  open(image: string): Promise<void>;
  isMounted(image: string): Promise<boolean>;
  eject(image: string, runningExecutable: string): Promise<boolean>;
}
type VerifiedUpdate = ReleaseUpdate & { sha256: string };
type Receipt = VerifiedUpdate & { dev: number; ino: number };
const receiptFile = "receipt.json";
const partialMarker = ".cod-download";
const cdnHost = "release-assets.githubusercontent.com";

function hasDigest(update: ReleaseUpdate): update is VerifiedUpdate {
  return (
    typeof update.sha256 === "string" && /^[a-f0-9]{64}$/.test(update.sha256)
  );
}
function directoryName(update: VerifiedUpdate): string {
  return `v${update.version}-${update.sha256}`;
}
function matchesUpdate(a: VerifiedUpdate, b: VerifiedUpdate): boolean {
  return directoryName(a) === directoryName(b) && a.size === b.size;
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
async function privateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.() ||
    (await realpath(directory)) !== directory
  )
    throw new Error("Update storage is not a private directory");
}
async function fileIdentity(file: string) {
  const info = await lstat(file);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.())
    throw new Error("Update file is not owned by Cod");
  return info;
}
async function readReceipt(directory: string): Promise<Receipt> {
  await privateDirectory(directory);
  const file = await open(
    path.join(directory, receiptFile),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("Invalid update record");
    const record = JSON.parse(await file.readFile("utf8")) as Receipt;
    if (
      !record ||
      !hasDigest(record) ||
      typeof record.version !== "string" ||
      !Number.isSafeInteger(record.size) ||
      record.size <= 0 ||
      !Number.isSafeInteger(record.dev) ||
      !Number.isSafeInteger(record.ino) ||
      path.basename(directory) !== directoryName(record) ||
      releaseImage(record.version).downloadUrl !== record.downloadUrl
    )
      throw new Error("Invalid update record");
    return record;
  } finally {
    await file.close();
  }
}
function isOwnedFile(
  info: Awaited<ReturnType<typeof fileIdentity>>,
  receipt: Receipt,
): boolean {
  return info.dev === receipt.dev && info.ino === receipt.ino;
}
function isRecordedFile(
  info: Awaited<ReturnType<typeof fileIdentity>>,
  receipt: Receipt,
): boolean {
  return isOwnedFile(info, receipt) && info.size === receipt.size;
}
async function removeOwnedImage(
  directory: string,
  file: string,
  receipt: Receipt,
) {
  await privateDirectory(directory);
  if (!isOwnedFile(await fileIdentity(file), receipt))
    throw new Error("The update file changed after verification");
  const record = path.join(directory, receiptFile);
  const marker = path.join(directory, partialMarker);
  await Promise.all([fileIdentity(record), fileIdentity(marker)]);
  await unlink(file);
  await unlink(record);
  await unlink(marker);
  await rmdir(directory);
}
async function verifyCachedImage(
  file: string,
  receipt: Receipt,
  signal: AbortSignal,
) {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      !isOwnedFile(stat, receipt)
    )
      throw new Error("Update image does not match its download record");
    if (stat.size !== receipt.size) return false;
    const sha = createHash("sha256");
    const stream = handle.createReadStream({ signal });
    let count = 0;
    for await (const buffer of stream) {
      count += buffer.length;
      if (count > receipt.size) return false;
      sha.update(buffer);
    }
    return count === receipt.size && sha.digest("hex") === receipt.sha256;
  } finally {
    await handle.close();
  }
}
async function discardInterruptedDownloads(storage: string) {
  for (const entry of await readdir(storage, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.partial-[a-zA-Z0-9]{6}$/.test(entry.name))
      continue;
    const directory = path.join(storage, entry.name);
    try {
      await privateDirectory(directory);
      const marker = path.join(directory, partialMarker);
      if ((await fileIdentity(marker)).size > 160) continue;
      const name = (await readFile(marker, "utf8")).trim();
      const version = /^Cod-(.+)-macOS-arm64\.dmg$/.exec(name)?.[1];
      if (!version || releaseImage(version).name !== name) continue;
      const fields = (await readdir(directory)).filter(
        (field) => field !== partialMarker,
      );
      if (fields.some((field) => field !== name && field !== receiptFile))
        continue;
      const owned = fields.map((field) => path.join(directory, field));
      await Promise.all(owned.map(fileIdentity));
      for (const file of owned) await unlink(file);
      await unlink(marker);
      await rmdir(directory);
    } catch {
      // Unrecognized files are outside interrupted download cleanup.
    }
  }
}

async function downloadImage(
  update: VerifiedUpdate,
  destination: string,
  request: typeof fetch,
  stop: AbortSignal,
) {
  const signal = AbortSignal.any([stop, AbortSignal.timeout(15 * 60 * 1000)]);
  const options: RequestInit = {
    redirect: "manual",
    credentials: "omit",
    signal,
  };
  let response = await request(update.downloadUrl, options);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const redirect = response.headers.get("location");
    await response.body?.cancel();
    const url = redirect ? new URL(redirect) : undefined;
    if (
      !url ||
      url.origin !== `https://${cdnHost}` ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("The update was redirected away from GitHub");
    response = await request(url, { ...options, redirect: "error" });
  }
  const length = response.headers.get("content-length");
  if (
    !response.ok ||
    !response.body ||
    (length !== null && Number(length) !== update.size)
  ) {
    await response.body?.cancel();
    throw new Error("The update download is unavailable or incomplete");
  }
  let count = 0;
  const sha = createHash("sha256");
  const hash = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      count += chunk.length;
      if (count > update.size) {
        callback(new Error("The update download was larger than expected"));
        return;
      }
      sha.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    hash,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  if (count !== update.size || sha.digest("hex") !== update.sha256)
    throw new Error("The update did not match GitHub’s size and checksum");
}

/** Owns a private cache inside the Electron profile locked by the application. */
export class ReleaseInstaller {
  private readonly profile: string;
  private readonly desktop: ReleaseInstallDesktop;
  private readonly request: typeof fetch;
  private active?: Promise<void>;
  private storage?: Promise<string>;

  constructor(
    profile: string,
    desktop: ReleaseInstallDesktop,
    request = fetch,
  ) {
    this.profile = profile;
    this.desktop = desktop;
    this.request = request;
  }

  private async directory(): Promise<string> {
    this.storage ??= this.initialize().catch((error) => {
      this.storage = undefined;
      throw error;
    });
    const storage = await this.storage;
    await privateDirectory(storage);
    return storage;
  }

  private async initialize(): Promise<string> {
    const storage = path.join(await realpath(this.profile), "release-updates");
    try {
      await mkdir(storage, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await privateDirectory(storage);
    await discardInterruptedDownloads(storage);
    return storage;
  }

  async ready(update: ReleaseUpdate): Promise<boolean> {
    if (!hasDigest(update)) return false;
    try {
      const { name } = releaseImage(update.version);
      const directory = path.join(
        await this.directory(),
        directoryName(update),
      );
      const receipt = await readReceipt(directory);
      const file = await fileIdentity(path.join(directory, name));
      return matchesUpdate(update, receipt) && isRecordedFile(file, receipt);
    } catch {
      return false;
    }
  }

  open(update: ReleaseUpdate, signal: AbortSignal): Promise<void> {
    if (!this.active)
      this.active = this.prepare(update, signal).finally(() => {
        this.active = undefined;
      });
    return this.active;
  }

  private async prepare(
    update: ReleaseUpdate,
    signal: AbortSignal,
  ): Promise<void> {
    const image = releaseImage(update.version);
    if (
      !hasDigest(update) ||
      image.downloadUrl !== update.downloadUrl ||
      !Number.isSafeInteger(update.size) ||
      update.size <= 0
    )
      throw new Error("GitHub did not provide a verifiable download");
    const directory = await this.directory();
    const ready = path.join(directory, directoryName(update));
    const destination = path.join(ready, image.name);
    let exists = false;
    try {
      await privateDirectory(ready);
      exists = true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    let receipt: Receipt | undefined;
    if (exists) {
      const record = await readReceipt(ready);
      if (!matchesUpdate(update, record))
        throw new Error("Unexpected cached update");
      if (await verifyCachedImage(destination, record, signal)) {
        if (!isRecordedFile(await fileIdentity(destination), record))
          throw new Error("The update file changed after verification");
        await this.desktop.quarantine(destination, update.downloadUrl);
        receipt = record;
      } else {
        if (await this.desktop.isMounted(destination))
          throw new Error("Eject the existing disk image before retrying");
        await removeOwnedImage(ready, destination, record);
      }
    }
    if (!receipt) {
      const stage = await mkdtemp(path.join(directory, ".partial-"));
      try {
        await writeFile(path.join(stage, partialMarker), image.name + "\n", {
          flag: "wx",
          mode: 0o600,
        });
        const partial = path.join(stage, image.name);
        await downloadImage(update, partial, this.request, signal);
        await this.desktop.quarantine(partial, update.downloadUrl);
        const { dev, ino } = await fileIdentity(partial);
        receipt = { ...update, dev, ino };
        await writeFile(
          path.join(stage, receiptFile),
          JSON.stringify(receipt),
          { flag: "wx", mode: 0o600 },
        );
        signal.throwIfAborted();
        try {
          await lstat(ready);
          throw new Error("The update cache path is already in use");
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        await rename(stage, ready);
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    }
    signal.throwIfAborted();
    await privateDirectory(ready);
    if (!isRecordedFile(await fileIdentity(destination), receipt))
      throw new Error("The update file changed after verification");
    await this.desktop.open(destination);
  }

  async cleanup(installed: string, runningExecutable: string): Promise<void> {
    const root = await this.directory();
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("v")) continue;
      const directory = path.join(root, entry.name);
      try {
        const receipt = await readReceipt(directory);
        if (!installedReleaseIncludes(installed, receipt.version)) continue;
        const image = path.join(directory, releaseImage(receipt.version).name);
        if (!isOwnedFile(await fileIdentity(image), receipt)) continue;
        if (!(await this.desktop.eject(image, runningExecutable))) continue;
        await removeOwnedImage(directory, image, receipt);
      } catch {
        // Leave busy images or anything outside the ownership record in place.
      }
    }
  }
}
