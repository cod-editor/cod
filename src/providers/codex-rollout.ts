import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveProviderExecutable } from "../provider-executables";
import { NativeAdapter } from "./adapter";

// Base64, the request envelope, and a bounded text draft share one 32 MiB frame.
export const maximumCodexRolloutBytes = 22 * 1024 * 1024;
const rolloutHeaderSampleBytes = 64 * 1024;
const keepChatHere = "You can keep using the chat in its current workspace.";
const linkedHistoryError =
  "This chat uses linked Codex history that cannot move to Linux yet. " +
  keepChatHere;

export interface CodexRollout {
  filename: string;
  bytes: string;
}

function sessionsDirectory(): string {
  return path.resolve(
    process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    "sessions",
  );
}

function rolloutDate(filename: string, nativeId: string): string[] {
  const date =
    /^rollout-(\d{4})-(\d{2})-(\d{2})T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?\.jsonl(\.zst)?$/.exec(
      filename,
    );
  if (!date || date[4] !== nativeId)
    throw new Error("The Codex session filename does not match its native ID");
  if (date[5]) throw new Error(linkedHistoryError);
  if (date[6])
    throw new Error(
      "This saved Codex history is compressed and cannot move to Linux yet. " +
        keepChatHere,
    );
  return date.slice(1, 4);
}

function checkSessionHeader(
  bytes: Buffer,
  nativeId: string,
  complete = bytes.at(-1) === 0x0a,
): void {
  const firstLine = bytes.indexOf(0x0a);
  if (firstLine < 0 || !complete)
    throw new Error("The saved Codex session is incomplete");
  const { type, payload } = JSON.parse(bytes.toString("utf8", 0, firstLine));
  if (type !== "session_meta" || payload?.id !== nativeId)
    throw new Error("The saved Codex session does not match its native ID");
  if (payload.history_base != null) throw new Error(linkedHistoryError);
}

async function readBytes(
  file: FileHandle,
  length: number,
  position = 0,
): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await file.read(bytes, 0, length, position);
  if (bytesRead !== length)
    throw new Error("The saved Codex session is still changing");
  return bytes;
}

async function readManagedRollout(
  nativeId: string,
  cwd: string,
  headerOnly: boolean,
): Promise<{ filename: string; bytes: Buffer }> {
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
  const root = await realpath(sessionsDirectory());
  const expected = path.join(root, ...date, filename);
  if ((await realpath(rollout)) !== expected)
    throw new Error("The session is outside the Codex sessions directory");
  const file = await open(
    expected,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const initial = await file.stat();
    if (!initial.isFile())
      throw new Error("The native session must be a regular file");
    if (initial.size > maximumCodexRolloutBytes)
      throw new Error(
        "This saved Codex session exceeds the 22 MiB transfer limit. " +
          keepChatHere,
      );
    const sampleLength = headerOnly
      ? Math.min(initial.size, rolloutHeaderSampleBytes)
      : initial.size;
    let bytes = await readBytes(file, sampleLength);
    // Long session metadata is valid. Inspect the bounded full file only if its
    // header did not fit in the sample.
    if (bytes.length < initial.size && !bytes.includes(0x0a))
      bytes = await readBytes(file, initial.size);
    const lastByte =
      bytes.length === initial.size
        ? bytes.at(-1)
        : (await readBytes(file, 1, initial.size - 1))[0];
    const final = await file.stat();
    if (
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs
    )
      throw new Error("The saved Codex session is still changing");
    checkSessionHeader(bytes, nativeId, lastByte === 0x0a);
    return { filename, bytes };
  } finally {
    await file.close();
  }
}

export async function preflightCodexRollout(
  nativeId: string,
  cwd: string,
): Promise<void> {
  await readManagedRollout(nativeId, cwd, true);
}

export async function readCodexRollout(
  nativeId: string,
  cwd: string,
): Promise<CodexRollout> {
  const { filename, bytes } = await readManagedRollout(nativeId, cwd, false);
  return { filename, bytes: bytes.toString("base64") };
}

async function rolloutDestination(
  date: string[],
  filename: string,
): Promise<string> {
  const root = sessionsDirectory();
  await mkdir(root, { recursive: true, mode: 0o700 });
  let directory = await realpath(root);
  for (const segment of date) {
    directory = path.join(directory, segment);
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    if (!(await lstat(directory)).isDirectory())
      throw new Error("The Codex sessions directory is unavailable");
  }
  return path.join(directory, filename);
}

/** Publish a complete file without replacing an already existing native session. */
export async function installCodexRollout(
  nativeId: string,
  rollout: CodexRollout,
  transferId: string,
): Promise<{ file: string; finish: (rollback?: boolean) => Promise<void> }> {
  if (
    typeof rollout?.filename !== "string" ||
    typeof rollout.bytes !== "string"
  )
    throw new Error("A saved Codex session file is required");
  const date = rolloutDate(rollout.filename, nativeId);
  if (rollout.bytes.length > Math.ceil(maximumCodexRolloutBytes / 3) * 4)
    throw new Error("This saved session exceeds the 22 MiB transfer limit");
  const bytes = Buffer.from(rollout.bytes, "base64");
  if (
    bytes.length > maximumCodexRolloutBytes ||
    bytes.toString("base64") !== rollout.bytes
  )
    throw new Error("The saved Codex session file was not encoded correctly");
  checkSessionHeader(bytes, nativeId);
  if (!/^[0-9a-f-]{36}$/.test(transferId))
    throw new Error("Invalid conversation transfer ID");
  const destination = await rolloutDestination(date, rollout.filename);
  const temporary = path.join(
    path.dirname(destination),
    `.transfer-${transferId}`,
  );
  const writing = temporary + "." + randomUUID();
  const sameFile = async () => {
    try {
      const from = await lstat(temporary);
      const to = await lstat(destination);
      return (
        from.isFile() &&
        to.isFile() &&
        from.dev === to.dev &&
        from.ino === to.ino
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  try {
    await writeFile(writing, bytes, { flag: "wx", mode: 0o600 });
    await link(writing, temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Native resume may append metadata to an already published rollout. The
    // caller verifies the original payload against the durable transfer digest.
    if (!(await sameFile())) {
      const saved = await lstat(temporary);
      if (
        !saved.isFile() ||
        saved.size !== bytes.length ||
        !(await readFile(temporary)).equals(bytes)
      )
        throw new Error("The staged session no longer matches this transfer");
    }
  } finally {
    await unlink(writing).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  try {
    await link(temporary, destination);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      !(await sameFile())
    ) {
      await unlink(temporary);
      throw error;
    }
  }
  return {
    file: destination,
    async finish(rollback = false) {
      if (rollback && (await sameFile())) await unlink(destination);
      await unlink(temporary);
    },
  };
}
