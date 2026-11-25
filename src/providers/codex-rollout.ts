import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveProviderExecutable } from "../provider-executables";
import { NativeAdapter } from "./adapter";

export const maximumCodexRolloutBytes = 256 * 1024 * 1024;
export const codexRolloutChunkBytes = 4 * 1024 * 1024;
const maximumHeaderBytes = 22 * 1024 * 1024;
const rolloutHeaderSampleBytes = 64 * 1024;
const keepChatHere = "You can keep using the chat in its current workspace.";
const linkedHistoryError =
  "This chat uses linked Codex history that cannot move to Linux yet. " +
  keepChatHere;
const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const rolloutName = new RegExp(
  `^rollout-(\\d{4})-(\\d{2})-(\\d{2})T\\d{2}-\\d{2}-\\d{2}-(${uuid})(?:_(${uuid}))?\\.jsonl(\\.zst)?$`,
);

export interface CodexRolloutFile {
  filename: string;
  size: number;
  digest: string;
}

interface SourceFile {
  filename: string;
  file: string;
  size: number;
  modified: {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    dev: number;
    ino: number;
  };
}

export function codexHome(): string {
  return path.resolve(
    process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
  );
}

function rolloutDate(filename: string, nativeId: string): string[] {
  const match = rolloutName.exec(filename);
  if (match?.[4] !== nativeId)
    throw new Error("The Codex session filename does not match its native ID");
  if (match[5]) throw new Error(linkedHistoryError);
  if (match[6])
    throw new Error(
      "This saved Codex history is compressed and cannot move to Linux yet. " +
        keepChatHere,
    );
  return match.slice(1, 4);
}

function checkSessionHeader(header: Buffer, nativeId: string): void {
  const { type, payload } = JSON.parse(header.toString("utf8"));
  if (type !== "session_meta" || payload?.id !== nativeId)
    throw new Error("The saved Codex session does not match its native ID");
  if (payload.history_base != null) throw new Error(linkedHistoryError);
}

async function readInto(file: FileHandle, bytes: Buffer, position: number) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.read(
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    );
    if (!bytesRead)
      throw new Error("The saved Codex session is still changing");
    offset += bytesRead;
  }
  return bytes;
}

function readBytes(file: FileHandle, length: number, position = 0) {
  return readInto(file, Buffer.alloc(length), position);
}

async function readHeader(file: FileHandle, size: number, nativeId: string) {
  const headerParts: Buffer[] = [];
  for (let offset = 0; offset < Math.min(size, maximumHeaderBytes);) {
    const length = Math.min(
      rolloutHeaderSampleBytes,
      Math.min(size, maximumHeaderBytes) - offset,
    );
    const chunk = await readBytes(file, length, offset);
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0) {
      headerParts.push(chunk.subarray(0, newline));
      return checkSessionHeader(Buffer.concat(headerParts), nativeId);
    }
    headerParts.push(chunk);
    offset += length;
  }
  throw new Error("The saved Codex session header is incomplete or too large");
}

function checkUnchanged(
  initial: SourceFile["modified"],
  current: SourceFile["modified"],
) {
  if (
    current.size !== initial.size ||
    current.mtimeMs !== initial.mtimeMs ||
    current.ctimeMs !== initial.ctimeMs ||
    current.dev !== initial.dev ||
    current.ino !== initial.ino
  )
    throw new Error("The saved Codex session is still changing");
}

const openRollout = (file: string) =>
  open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

async function inspectRollout(file: string, nativeId: string) {
  const handle = await openRollout(file);
  try {
    const modified = await handle.stat();
    const size = modified.size;
    if (!modified.isFile())
      throw new Error("The native session must be a regular file");
    if (size > maximumCodexRolloutBytes)
      throw new Error(
        "This saved Codex session exceeds the 256 MiB transfer limit. " +
          keepChatHere,
      );
    if (size <= 0 || (await readBytes(handle, 1, size - 1))[0] !== 0x0a)
      throw new Error("The saved Codex session is incomplete");
    await readHeader(handle, size, nativeId);
    checkUnchanged(modified, await handle.stat());
    return { filename: path.basename(file), file, size, modified };
  } finally {
    await handle.close();
  }
}

async function archivedDirectory(): Promise<string | undefined> {
  const root = path.join(codexHome(), "archived_sessions");
  try {
    return await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// An independently existing native revision may have a different basename.
// The native directory scan checks both active dates and flat archived names.
async function otherManagedRollout(
  activeRoot: string,
  nativeId: string,
  owned: string,
): Promise<boolean> {
  const matches = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (
        entry.isFile() &&
        rolloutName.exec(entry.name)?.[4] === nativeId &&
        path.join(directory, entry.name) !== owned
      )
        return true;
    return false;
  };
  const visitDates = async (
    directory: string,
    depth: number,
  ): Promise<boolean> => {
    if (depth === 3) return matches(directory);
    const component = depth === 0 ? /^\d{4}$/ : /^\d{2}$/;
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        component.test(entry.name) &&
        (await visitDates(path.join(directory, entry.name), depth + 1))
      )
        return true;
    return false;
  };
  if (await visitDates(activeRoot, 0)) return true;
  const archive = await archivedDirectory();
  return archive ? matches(archive) : false;
}

async function inspectManagedRollout(
  nativeId: string,
  cwd: string,
): Promise<SourceFile> {
  const adapter = new NativeAdapter("codex", {
    cwd,
    ...(await resolveProviderExecutable("codex")),
  });
  let rollout: string;
  try {
    rollout = await adapter.codexRolloutPath(nativeId);
  } finally {
    await adapter.dispose();
  }
  const filename = path.basename(rollout);
  const date = rolloutDate(filename, nativeId);
  const root = await realpath(path.join(codexHome(), "sessions"));
  const expected = path.join(root, ...date, filename);
  if ((await realpath(rollout)) !== expected)
    throw new Error("The session is outside the Codex sessions directory");
  return inspectRollout(expected, nativeId);
}

export async function preflightCodexRollout(
  nativeId: string,
  cwd: string,
): Promise<void> {
  await inspectManagedRollout(nativeId, cwd);
}

async function* bytesOf(file: SourceFile): AsyncGenerator<Buffer> {
  const handle = await openRollout(file.file);
  try {
    checkUnchanged(file.modified, await handle.stat());
    // Consumers hash or encode each chunk before advancing the iterator.
    const buffer = Buffer.alloc(Math.min(codexRolloutChunkBytes, file.size));
    for (let offset = 0; offset < file.size; offset += buffer.length)
      yield await readInto(
        handle,
        buffer.subarray(0, file.size - offset),
        offset,
      );
    checkUnchanged(file.modified, await handle.stat());
  } finally {
    await handle.close();
  }
}

async function digestOf(file: SourceFile): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of bytesOf(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function readCodexRollout(nativeId: string, cwd: string) {
  const file = await inspectManagedRollout(nativeId, cwd);
  const manifest = {
    filename: file.filename,
    size: file.size,
    digest: await digestOf(file),
  };
  return { manifest, read: () => bytesOf(file) };
}

export function validateCodexRolloutManifest(
  input: unknown,
  nativeId: string,
): CodexRolloutFile {
  const file = input as CodexRolloutFile | undefined;
  if (
    typeof file?.filename !== "string" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    typeof file.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(file.digest)
  )
    throw new Error("Invalid Codex session manifest");
  rolloutDate(file.filename, nativeId);
  if (file.size > maximumCodexRolloutBytes)
    throw new Error(
      "This saved Codex session exceeds the 256 MiB transfer limit",
    );
  return { filename: file.filename, size: file.size, digest: file.digest };
}

async function rolloutDestination(file: CodexRolloutFile, nativeId: string) {
  const date = rolloutDate(file.filename, nativeId);
  const sessions = path.join(codexHome(), "sessions");
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const root = await realpath(sessions);
  let directory = root;
  for (const segment of date) {
    directory = path.join(directory, segment);
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (!isExisting(error)) throw error;
    });
    if (!(await lstat(directory)).isDirectory())
      throw new Error("The Codex sessions directory is unavailable");
  }
  return { root, destination: path.join(directory, file.filename) };
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isExisting(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

async function sameFile(left: string, right: string): Promise<boolean> {
  try {
    const [from, to] = await Promise.all([lstat(left), lstat(right)]);
    return (
      from.isFile() && to.isFile() && from.dev === to.dev && from.ino === to.ino
    );
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function remove(file: string) {
  await unlink(file).catch((error) => {
    if (!isMissing(error)) throw error;
  });
}

/** Validate the staged file, then publish it without replacing native history. */
export async function installCodexRollout(
  nativeId: string,
  manifest: CodexRolloutFile,
  stagedFile: string,
  transferId: string,
): Promise<{ file: string; finish: (rollback?: boolean) => Promise<void> }> {
  const staged = await inspectRollout(stagedFile, nativeId);
  if (
    staged.size !== manifest.size ||
    (await digestOf(staged)) !== manifest.digest
  )
    throw new Error("The staged session does not match its transfer");
  const { destination, root } = await rolloutDestination(manifest, nativeId);
  const temporary = path.join(
    path.dirname(destination),
    `.transfer-${transferId}`,
  );
  const writing = temporary + ".writing";
  if (await otherManagedRollout(root, nativeId, destination))
    throw new Error(
      "This Codex session already has saved history on the Linux host",
    );
  const finish = async (rollback = false) => {
    if (rollback && (await sameFile(temporary, destination)))
      await remove(destination);
    await remove(temporary);
  };
  // A previous host process may have died during this transfer's scratch copy.
  // The durable transfer binds this pathname before any native file is installed.
  await remove(writing);
  try {
    await copyFile(stagedFile, writing, constants.COPYFILE_EXCL);
    await link(writing, temporary);
  } catch (error) {
    if (!isExisting(error)) throw error;
    // A previous resume may have appended records to the installed file.
    if (!(await sameFile(temporary, destination))) {
      const saved = await inspectRollout(temporary, nativeId);
      if (
        saved.size !== manifest.size ||
        (await digestOf(saved)) !== manifest.digest
      )
        throw new Error("The staged session no longer matches this transfer");
    }
  } finally {
    await remove(writing);
  }
  try {
    await link(temporary, destination);
  } catch (error) {
    if (!isExisting(error) || !(await sameFile(temporary, destination))) {
      await finish(true);
      throw new Error(
        "This Codex session already has saved history on the Linux host",
        { cause: error },
      );
    }
  }
  return { file: destination, finish };
}
