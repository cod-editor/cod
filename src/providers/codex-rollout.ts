import { constants, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
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
const maximumRolloutFiles = 16;
const maximumHeaderBytes = 22 * 1024 * 1024;
const rolloutHeaderSampleBytes = 64 * 1024;
const keepChatHere = "You can keep using the chat in its current workspace.";
const linkedHistoryError =
  "This chat uses unsupported linked Codex history. " + keepChatHere;
const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const rolloutName = new RegExp(
  `^rollout-(\\d{4})-(\\d{2})-(\\d{2})T\\d{2}-\\d{2}-\\d{2}-(${uuid})(?:_(${uuid}))?\\.jsonl(\\.zst)?$`,
);

export interface CodexRolloutFile {
  filename: string;
  size: number;
  digest: string;
}

export interface LinkedCodexRollout {
  files: CodexRolloutFile[];
  history: { lastTurnId: string; digest: string };
}

export type CodexRolloutManifest = CodexRolloutFile | LinkedCodexRollout;

function rolloutFiles(manifest: CodexRolloutManifest): CodexRolloutFile[] {
  return "files" in manifest ? manifest.files : [manifest];
}

export function codexRolloutSize(manifest: CodexRolloutManifest): number {
  return rolloutFiles(manifest).reduce((total, file) => total + file.size, 0);
}

interface HistoryBase {
  thread_id: string;
  end_byte_offset: number;
  end_ordinal_exclusive: number;
}

interface SourceFile {
  filename: string;
  file: string;
  offset: number;
  size: number;
  base?: HistoryBase;
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

function identifyRollout(filename: string, nativeId: string) {
  const match = rolloutName.exec(filename);
  if (match?.[4] !== nativeId)
    throw new Error("The Codex session filename does not match its native ID");
  if (match[6])
    throw new Error(
      "This saved Codex history is compressed and cannot move to Linux yet. " +
        keepChatHere,
    );
  return { date: match.slice(1, 4), revision: match[5] ?? nativeId };
}

const nativeIdentity = new RegExp(`^${uuid}$`);
const sha256Digest = /^[a-f0-9]{64}$/;

function checkSessionHeader(
  header: Buffer,
  nativeId: string,
): HistoryBase | undefined {
  const { type, payload } = JSON.parse(header.toString("utf8"));
  if (type !== "session_meta" || payload?.id !== nativeId)
    throw new Error("The saved Codex session does not match its native ID");
  const base = payload.history_base;
  if (base == null) return;
  if (
    typeof base.thread_id !== "string" ||
    !nativeIdentity.test(base.thread_id) ||
    !Number.isSafeInteger(base.end_byte_offset) ||
    base.end_byte_offset < 1 ||
    !Number.isSafeInteger(base.end_ordinal_exclusive) ||
    base.end_ordinal_exclusive < 1
  )
    throw new Error(linkedHistoryError);
  return {
    thread_id: base.thread_id,
    end_byte_offset: base.end_byte_offset,
    end_ordinal_exclusive: base.end_ordinal_exclusive,
  };
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

async function readHeader(
  file: FileHandle,
  start: number,
  size: number,
  nativeId: string,
) {
  const headerParts: Buffer[] = [];
  for (let offset = 0; offset < Math.min(size, maximumHeaderBytes);) {
    const length = Math.min(
      rolloutHeaderSampleBytes,
      Math.min(size, maximumHeaderBytes) - offset,
    );
    const chunk = await readBytes(file, length, start + offset);
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

async function verifyRetainedOrdinal(
  file: FileHandle,
  start: number,
  size: number,
  ordinal: number,
) {
  const end = start + size - 1;
  const parts: Buffer[] = [];
  const minimum = Math.max(start, end - maximumHeaderBytes);
  for (let cursor = end; cursor > minimum;) {
    const from = Math.max(minimum, cursor - rolloutHeaderSampleBytes);
    const part = await readBytes(file, cursor - from, from);
    const newline = part.lastIndexOf(0x0a);
    if (newline >= 0 || from === start) {
      const record = JSON.parse(
        Buffer.concat([part.subarray(newline + 1), ...parts]).toString("utf8"),
      );
      if (record?.ordinal !== ordinal)
        throw new Error(
          "The retained Codex segment does not match its ordinal",
        );
      return;
    }
    parts.unshift(part);
    cursor = from;
  }
  throw new Error("The retained Codex segment ends in an unsupported record");
}

async function inspectRollout(
  file: string,
  nativeId: string,
  {
    offset = 0,
    length,
    ordinal,
    filename = path.basename(file),
  }: {
    offset?: number;
    length?: number;
    ordinal?: number;
    filename?: string;
  } = {},
): Promise<SourceFile> {
  const handle = await openRollout(file);
  try {
    const modified = await handle.stat();
    const size = length ?? modified.size;
    if (!modified.isFile())
      throw new Error("The native session must be a regular file");
    if (size > maximumCodexRolloutBytes)
      throw new Error(
        "This saved Codex session exceeds the 256 MiB transfer limit. " +
          keepChatHere,
      );
    if (
      size <= 0 ||
      offset + size > modified.size ||
      (await readBytes(handle, 1, offset + size - 1))[0] !== 0x0a
    )
      throw new Error("The saved Codex session is incomplete");
    const base = await readHeader(handle, offset, size, nativeId);
    if (ordinal !== undefined)
      await verifyRetainedOrdinal(handle, offset, size, ordinal);
    checkUnchanged(modified, await handle.stat());
    return { filename, file, offset, size, modified, base };
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

// Only scan names in the provider-managed layouts. Different logical IDs
// are never opened to look for a linked revision.
async function managedRollouts(activeRoot: string, nativeId: string) {
  const revisions = new Map<string, string[]>();
  const add = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = rolloutName.exec(entry.name);
      if (match?.[4] !== nativeId) continue;
      const revision = match[5] ?? nativeId;
      const files = revisions.get(revision) ?? [];
      files.push(path.join(directory, entry.name));
      revisions.set(revision, files);
    }
  };
  const visitDates = async (
    directory: string,
    depth: number,
  ): Promise<void> => {
    if (depth === 3) return add(directory);
    const component = depth === 0 ? /^\d{4}$/ : /^\d{2}$/;
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory() && component.test(entry.name))
        await visitDates(path.join(directory, entry.name), depth + 1);
  };
  await visitDates(activeRoot, 0);
  const archive = await archivedDirectory();
  if (archive) await add(archive);
  return revisions;
}

async function codexReader(cwd: string) {
  return new NativeAdapter("codex", {
    cwd,
    ...(await resolveProviderExecutable("codex")),
  });
}

export async function supportsLinkedCodexRollout(
  cwd: string,
): Promise<boolean> {
  const reader = await codexReader(cwd);
  try {
    return await reader.supportsLinkedCodexTransfer();
  } finally {
    await reader.dispose();
  }
}

async function inspectManagedRollout(nativeId: string, reader: NativeAdapter) {
  const rollout = await reader.codexRolloutPath(nativeId);
  const filename = path.basename(rollout);
  const { date, revision } = identifyRollout(filename, nativeId);
  const root = await realpath(path.join(codexHome(), "sessions"));
  const selected = path.join(root, ...date, filename);
  if ((await realpath(rollout)) !== selected)
    throw new Error("The session is outside the Codex sessions directory");
  let leaf = await inspectRollout(selected, nativeId);
  const files = [leaf];
  if (!leaf.base && revision === nativeId) return files;
  if (
    !leaf.base ||
    revision === nativeId ||
    !(await reader.supportsLinkedCodexTransfer())
  )
    throw new Error(linkedHistoryError);
  const revisions = await managedRollouts(root, nativeId);
  const seen = new Set([revision]);
  let total = leaf.size;
  while (leaf.base) {
    const { thread_id, end_byte_offset, end_ordinal_exclusive } = leaf.base;
    const paths = revisions.get(thread_id);
    if (
      seen.has(thread_id) ||
      paths?.length !== 1 ||
      files.length >= maximumRolloutFiles
    )
      throw new Error(linkedHistoryError);
    total += end_byte_offset;
    if (total > maximumCodexRolloutBytes)
      throw new Error(
        "This saved Codex session exceeds the 256 MiB transfer limit. " +
          keepChatHere,
      );
    const file = paths[0];
    identifyRollout(path.basename(file), nativeId);
    if ((await realpath(file)) !== file) throw new Error(linkedHistoryError);
    leaf = await inspectRollout(file, nativeId, {
      length: end_byte_offset,
      ordinal: end_ordinal_exclusive - 1,
    });
    seen.add(thread_id);
    files.push(leaf);
  }
  return files;
}

export async function preflightCodexRollout(
  nativeId: string,
  cwd: string,
): Promise<boolean> {
  const reader = await codexReader(cwd);
  try {
    return (await inspectManagedRollout(nativeId, reader)).length > 1;
  } finally {
    await reader.dispose();
  }
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
        file.offset + offset,
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

async function* combinedChunks(files: SourceFile[]): AsyncGenerator<Buffer> {
  if (files.length === 1) {
    yield* bytesOf(files[0]);
    return;
  }
  const buffer = Buffer.alloc(codexRolloutChunkBytes);
  let filled = 0;
  for (const file of files) {
    for await (const piece of bytesOf(file)) {
      let offset = 0;
      while (offset < piece.length) {
        const copied = piece.copy(buffer, filled, offset);
        offset += copied;
        filled += copied;
        if (filled === buffer.length) {
          yield buffer;
          filled = 0;
        }
      }
    }
  }
  if (filled) yield buffer.subarray(0, filled);
}

export async function readCodexRollout(nativeId: string, cwd: string) {
  const reader = await codexReader(cwd);
  try {
    const files = await inspectManagedRollout(nativeId, reader);
    const descriptors: CodexRolloutFile[] = [];
    for (const file of files)
      descriptors.push({
        filename: file.filename,
        size: file.size,
        digest: await digestOf(file),
      });
    const manifest: CodexRolloutManifest =
      files.length === 1
        ? descriptors[0]
        : {
            files: descriptors,
            history: await reader.codexLinkedTransferProof(nativeId),
          };
    return { manifest, read: () => combinedChunks(files) };
  } finally {
    await reader.dispose();
  }
}

function validateRolloutFile(input: unknown, nativeId: string) {
  const file = input as CodexRolloutFile | undefined;
  if (
    typeof file?.filename !== "string" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    typeof file.digest !== "string" ||
    !sha256Digest.test(file.digest)
  )
    throw new Error("Invalid Codex session manifest");
  const { revision } = identifyRollout(file.filename, nativeId);
  return {
    descriptor: {
      filename: file.filename,
      size: file.size,
      digest: file.digest,
    },
    revision,
  };
}

export function validateCodexRolloutManifest(
  input: unknown,
  nativeId: string,
): CodexRolloutManifest {
  const linked = input as LinkedCodexRollout | undefined;
  if (linked?.files === undefined) {
    const { descriptor, revision } = validateRolloutFile(input, nativeId);
    if (revision !== nativeId) throw new Error(linkedHistoryError);
    if (descriptor.size > maximumCodexRolloutBytes)
      throw new Error(
        "This saved Codex session exceeds the 256 MiB transfer limit",
      );
    return descriptor;
  }
  if (
    !Array.isArray(linked.files) ||
    linked.files.length < 2 ||
    linked.files.length > maximumRolloutFiles ||
    typeof linked.history?.lastTurnId !== "string" ||
    !nativeIdentity.test(linked.history.lastTurnId) ||
    typeof linked.history.digest !== "string" ||
    !sha256Digest.test(linked.history.digest)
  )
    throw new Error(linkedHistoryError);
  const revisions = new Set<string>();
  const files = linked.files.map((file) => {
    const { descriptor, revision } = validateRolloutFile(file, nativeId);
    if (revisions.has(revision) || (!revisions.size && revision === nativeId))
      throw new Error(linkedHistoryError);
    revisions.add(revision);
    return descriptor;
  });
  const manifest = {
    files,
    history: {
      lastTurnId: linked.history.lastTurnId,
      digest: linked.history.digest,
    },
  };
  if (codexRolloutSize(manifest) > maximumCodexRolloutBytes)
    throw new Error(
      "This saved Codex session exceeds the 256 MiB transfer limit",
    );
  return manifest;
}

async function rolloutDestination(
  file: CodexRolloutFile,
  nativeId: string,
  archived: boolean,
) {
  const { date } = identifyRollout(file.filename, nativeId);
  const sessions = path.join(
    codexHome(),
    archived ? "archived_sessions" : "sessions",
  );
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  let directory = await realpath(sessions);
  for (const segment of archived ? [] : date) {
    directory = path.join(directory, segment);
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (!isExisting(error)) throw error;
    });
    if (!(await lstat(directory)).isDirectory())
      throw new Error("The Codex sessions directory is unavailable");
  }
  return path.join(directory, file.filename);
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

async function copyStagedFile(
  source: SourceFile,
  writing: string,
  linked: boolean,
) {
  if (!linked) return copyFile(source.file, writing, constants.COPYFILE_EXCL);
  const handle = await openRollout(source.file);
  try {
    checkUnchanged(source.modified, await handle.stat());
    await pipeline(
      handle.createReadStream({
        autoClose: false,
        start: source.offset,
        end: source.offset + source.size - 1,
      }),
      createWriteStream(writing, { flags: "wx", mode: 0o600 }),
    );
    checkUnchanged(source.modified, await handle.stat());
  } finally {
    await handle.close();
  }
}

/** Validate every range before publishing. The selected segment is published last. */
export async function installCodexRollout(
  nativeId: string,
  manifest: CodexRolloutManifest,
  stagedFile: string,
  transferId: string,
): Promise<{ file: string; finish: (rollback?: boolean) => Promise<void> }> {
  const linked = "files" in manifest;
  const descriptors = rolloutFiles(manifest);
  const parts: SourceFile[] = [];
  let offset = 0;
  let expected: HistoryBase | undefined;
  for (const [index, descriptor] of descriptors.entries()) {
    if (
      index > 0 &&
      (expected?.thread_id !==
        identifyRollout(descriptor.filename, nativeId).revision ||
        expected.end_byte_offset !== descriptor.size)
    )
      throw new Error("The staged session does not match its linked revision");
    const part = await inspectRollout(stagedFile, nativeId, {
      filename: descriptor.filename,
      offset,
      length: descriptor.size,
      ordinal: expected ? expected.end_ordinal_exclusive - 1 : undefined,
    });
    if (!linked && part.base) throw new Error(linkedHistoryError);
    if ((await digestOf(part)) !== descriptor.digest)
      throw new Error("The staged session does not match its transfer");
    expected = part.base;
    offset += part.size;
    parts.push(part);
  }
  if (expected || offset !== parts[0].modified.size)
    throw new Error("The staged session does not match its transfer");
  if (linked && !parts[0].base) throw new Error(linkedHistoryError);

  const targets: Array<{ destination: string; temporary: string }> = [];
  for (const [index, descriptor] of descriptors.entries()) {
    const destination = await rolloutDestination(
      descriptor,
      nativeId,
      index > 0,
    );
    const temporary = path.join(
      path.dirname(destination),
      `.transfer-${transferId}${linked ? "-" + index : ""}`,
    );
    targets.push({ destination, temporary });
  }
  const root = await realpath(path.join(codexHome(), "sessions"));
  for (const paths of (await managedRollouts(root, nativeId)).values()) {
    for (const existing of paths) {
      const target = targets.find(
        ({ destination }) => destination === existing,
      );
      if (!target || !(await sameFile(target.temporary, existing)))
        throw new Error(
          "This Codex session already has saved history on the Linux host",
        );
    }
  }
  const finish = async (rollback = false) => {
    for (const { temporary, destination } of targets) {
      if (rollback && (await sameFile(temporary, destination)))
        await remove(destination);
      await remove(temporary);
    }
  };
  try {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const { destination, temporary } = targets[index];
      const part = parts[index];
      const writing = temporary + ".writing";
      await remove(writing);
      try {
        await copyStagedFile(part, writing, linked);
        await link(writing, temporary);
      } catch (error) {
        if (!isExisting(error)) throw error;
        // A previous resume can append records to an installed active file.
        if (!(await sameFile(temporary, destination))) {
          const saved = await inspectRollout(temporary, nativeId);
          if (
            saved.size !== part.size ||
            (await digestOf(saved)) !== descriptors[index].digest
          )
            throw new Error(
              "The staged session no longer matches this transfer",
            );
        }
      } finally {
        await remove(writing);
      }
      try {
        await link(temporary, destination);
      } catch (error) {
        if (!isExisting(error) || !(await sameFile(temporary, destination)))
          throw new Error(
            "This Codex session already has saved history on the Linux host",
            { cause: error },
          );
      }
    }
  } catch (error) {
    await finish(true);
    throw error;
  }
  return { file: targets[0].destination, finish };
}

export async function reindexLinkedCodexRollout(
  nativeId: string,
  cwd: string,
  rolloutPath: string,
  lastTurnId: string,
) {
  const reader = await codexReader(cwd);
  try {
    if ((await reader.codexRolloutPath(nativeId)) !== rolloutPath)
      throw new Error(
        "The destination selected a different Codex session file",
      );
    await reader.codexReindexLinkedTransfer(nativeId, lastTurnId);
  } finally {
    await reader.dispose();
  }
}

export async function verifyLinkedCodexRollout(
  nativeId: string,
  cwd: string,
  rolloutPath: string,
  history: LinkedCodexRollout["history"],
) {
  const reader = await codexReader(cwd);
  try {
    if (!(await reader.codexDiscoverImportedThread(nativeId, rolloutPath)))
      throw new Error("Codex could not rediscover the imported session");
    const proof = await reader.codexLinkedTransferProof(nativeId);
    if (
      proof.lastTurnId !== history.lastTurnId ||
      proof.digest !== history.digest
    )
      throw new Error("The imported Codex history does not match the source");
  } finally {
    await reader.dispose();
  }
}
