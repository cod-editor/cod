import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  link,
  rm,
  writeFile,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import {
  codexHome,
  codexRolloutChunkBytes,
  validateCodexRolloutManifest,
  codexRolloutSize,
  type CodexRolloutManifest,
} from "./codex-rollout";

const maximumStagedTransfers = 4;
const stagingLifetimeMs = 15 * 60 * 1000;
const transferIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const isExisting = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "EEXIST";
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

interface TransferBinding {
  nativeId: string;
  workspace: string;
  cwd: string;
}

interface StageRecord {
  binding: TransferBinding;
  manifest: CodexRolloutManifest;
}

function stagingRoot() {
  return path.join(codexHome(), ".cod-transfer-staging");
}

function stagePath(transferId: string) {
  if (!transferIdPattern.test(transferId))
    throw new Error("Invalid Codex transfer ID");
  return path.join(stagingRoot(), transferId);
}

async function readStage(directory: string): Promise<StageRecord> {
  if (!(await lstat(directory)).isDirectory())
    throw new Error("The Codex transfer stage is unavailable");
  const manifest = await open(
    path.join(directory, "manifest.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stats = await manifest.stat();
    if (!stats.isFile() || stats.size > 64 * 1024)
      throw new Error("The Codex transfer manifest is unavailable");
    return JSON.parse(await manifest.readFile("utf8")) as StageRecord;
  } finally {
    await manifest.close();
  }
}

function checkBinding(actual: TransferBinding, expected: TransferBinding) {
  if (
    actual.nativeId !== expected.nativeId ||
    actual.workspace !== expected.workspace ||
    actual.cwd !== expected.cwd
  )
    throw new Error("The staged session no longer matches this transfer");
}

export function codexStageDigest(manifest: CodexRolloutManifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export async function beginCodexStage(
  transferId: string,
  binding: TransferBinding,
  input: unknown,
  protectedTransfers: ReadonlySet<string> = new Set(),
) {
  const directory = stagePath(transferId);
  const manifest = validateCodexRolloutManifest(input, binding.nativeId);
  await mkdir(stagingRoot(), { mode: 0o700, recursive: true });
  if (!(await lstat(stagingRoot())).isDirectory())
    throw new Error("The Codex transfer stage is unavailable");
  const stages = await readdir(stagingRoot(), { withFileTypes: true });
  let live = 0;
  for (const stage of stages) {
    if (
      !stage.isDirectory() ||
      !transferIdPattern.test(stage.name) ||
      stage.name === transferId
    )
      continue;
    const existing = stagePath(stage.name);
    try {
      const stats = await lstat(existing);
      if (
        !protectedTransfers.has(stage.name) &&
        Date.now() - stats.mtimeMs > stagingLifetimeMs
      )
        await rm(existing, { recursive: true, force: true });
      else live += 1;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  try {
    const record = await readStage(directory);
    checkBinding(record.binding, binding);
    if (codexStageDigest(record.manifest) !== codexStageDigest(manifest))
      throw new Error("The staged session no longer matches this transfer");
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (live >= maximumStagedTransfers)
    throw new Error("The Linux host already has too many staged Codex moves");
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  if (!(await lstat(directory)).isDirectory())
    throw new Error("The Codex transfer stage is unavailable");
  const current = await readdir(stagingRoot(), { withFileTypes: true });
  if (
    current.filter(
      (item) => item.isDirectory() && transferIdPattern.test(item.name),
    ).length > maximumStagedTransfers
  ) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("The Linux host already has too many staged Codex moves");
  }
  const reservation = path.join(directory, "manifest-" + randomUUID());
  try {
    await writeFile(reservation, JSON.stringify({ binding, manifest }), {
      mode: 0o600,
      flag: "wx",
    });
    await link(reservation, path.join(directory, "manifest.json"));
  } catch (error) {
    if (!isExisting(error)) throw error;
    const record = await readStage(directory);
    checkBinding(record.binding, binding);
    if (codexStageDigest(record.manifest) !== codexStageDigest(manifest))
      throw new Error("The staged session no longer matches this transfer");
  } finally {
    await rm(reservation, { force: true });
  }
}

const chunkPath = (directory: string) => path.join(directory, "rollout.part");

async function uploaded(file: string) {
  try {
    const stats = await lstat(file);
    if (!stats.isFile()) throw new Error("Invalid staged Codex session file");
    return stats.size;
  } catch (error) {
    if (!missing(error)) throw error;
    return 0;
  }
}

export async function appendCodexChunk(
  transferId: string,
  binding: TransferBinding,
  offset: unknown,
  encoded: unknown,
) {
  const directory = stagePath(transferId);
  const { binding: actual, manifest } = await readStage(directory);
  checkBinding(actual, binding);
  const total = codexRolloutSize(manifest);
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset % codexRolloutChunkBytes !== 0 ||
    offset >= total ||
    typeof encoded !== "string" ||
    encoded.length > Math.ceil(codexRolloutChunkBytes / 3) * 4
  )
    throw new Error("Invalid Codex session chunk");
  const bytes = Buffer.from(encoded, "base64");
  const length = Math.min(codexRolloutChunkBytes, total - offset);
  if (bytes.length !== length || bytes.toString("base64") !== encoded)
    throw new Error("Invalid Codex session chunk");
  const file = chunkPath(directory);
  const size = await uploaded(file);
  if (size < offset || size > total)
    throw new Error("Codex session chunks arrived out of order");
  const handle = await open(
    file,
    constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR,
    0o600,
  );
  try {
    const overlap = Math.min(length, size - offset);
    if (overlap > 0) {
      const existing = Buffer.alloc(overlap);
      const result = await handle.read(existing, 0, overlap, offset);
      if (
        result.bytesRead !== overlap ||
        !existing.equals(bytes.subarray(0, overlap))
      )
        throw new Error("The retried Codex session chunk has changed");
    }
    if (overlap < length) {
      let written = overlap;
      while (written < length) {
        const result = await handle.write(
          bytes,
          written,
          length - written,
          offset + written,
        );
        if (!result.bytesWritten)
          throw new Error("The Codex session chunk could not be saved");
        written += result.bytesWritten;
      }
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
  const now = new Date();
  await utimes(directory, now, now);
}

export async function readCodexStage(
  transferId: string,
  binding: TransferBinding,
) {
  const directory = stagePath(transferId);
  const { binding: actual, manifest } = await readStage(directory);
  checkBinding(actual, binding);
  const file = chunkPath(directory);
  if ((await uploaded(file)) !== codexRolloutSize(manifest))
    throw new Error("The staged Codex session is incomplete");
  return { file, manifest };
}

export async function removeCodexStage(
  transferId: string,
  binding: TransferBinding,
) {
  const directory = stagePath(transferId);
  try {
    checkBinding((await readStage(directory)).binding, binding);
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    if (!missing(error)) throw error;
  }
}
