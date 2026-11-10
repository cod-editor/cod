import { createHash, randomUUID } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ProjectService } from "../projects/index.ts";
export type Target =
  | { kind: "document"; path: string }
  | { kind: "diff"; repoRoot: string; base?: string; head?: string };
export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  old: Record<number, string>;
  new: Record<number, string>;
}
export interface Snapshot {
  id: string;
  kind: "document" | "diff";
  hash: string;
  text: string;
  base: string | null;
  head: string | null;
  files: DiffFile[];
}
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const lines = (text: string) => {
  const values = text.split("\n");
  if (values.at(-1) === "") values.pop();
  return values.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
};
const inside = (root: string, file: string) =>
  file === root ||
  (!path.relative(root, file).startsWith(".." + path.sep) &&
    path.relative(root, file) !== ".." &&
    !path.isAbsolute(path.relative(root, file)));
function gitName(value: string) {
  if (!value.startsWith('"')) return value.replace(/\t$/, "");
  const bytes: number[] = [];
  for (let i = 1; i < value.length;) {
    let char = value[i++];
    if (char === '"') {
      // Working-tree headers may append a tab after the closing quote. It is
      // a Git delimiter, not part of the quoted name; preserve all inner spaces.
      const suffix = value.slice(i);
      if (suffix !== "" && suffix !== "\t")
        throw new Error("Unsupported quoted diff path suffix");
      return new TextDecoder("utf8", { fatal: true }).decode(
        Buffer.from(bytes),
      );
    }
    if (char === "\\") {
      if (i >= value.length) throw new Error("Incomplete quoted diff path");
      char = value[i++];
      if (/[0-7]/.test(char)) {
        let octal = char;
        while (octal.length < 3 && /[0-7]/.test(value[i] ?? ""))
          octal += value[i++];
        bytes.push(parseInt(octal, 8));
        continue;
      }
      const escaped = (
        {
          t: "\t",
          n: "\n",
          r: "\r",
          b: "\b",
          f: "\f",
          v: "\v",
          a: "\x07",
          '"': '"',
          "\\": "\\",
        } as Record<string, string>
      )[char];
      if (escaped === undefined)
        throw new Error("Unsupported diff path escape");
      char = escaped;
    } else {
      // core.quotepath=false can retain literal non-BMP Unicode inside quotes.
      char = String.fromCodePoint(value.codePointAt(i - 1)!);
      i += char.length - 1;
    }
    bytes.push(...Buffer.from(char));
  }
  throw new Error("Unterminated quoted diff path");
}

function manifest(text: string, repoRoot: string): DiffFile[] {
  if (
    /^(Binary files |GIT binary patch|diff --cc |diff --combined )/m.test(text)
  )
    throw new Error("Binary or combined diffs cannot be reviewed");
  const files: DiffFile[] = [];
  let current: DiffFile | undefined,
    oldLine = 0,
    newLine = 0,
    oldRemaining = 0,
    newRemaining = 0;
  const name = (value: string, prefix: "a/" | "b/") => {
    const decoded = gitName(value);
    if (decoded === "/dev/null") return null;
    if (!decoded.startsWith(prefix))
      throw new Error("Unsupported diff path prefix");
    const full = path.resolve(repoRoot, decoded.slice(2));
    if (!inside(repoRoot, full))
      throw new Error("Diff path escapes repository");
    return full;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (oldRemaining || newRemaining) throw new Error("Incomplete diff hunk");
      current = { oldPath: null, newPath: null, old: {}, new: {} };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (oldRemaining || newRemaining) {
      if (line.startsWith("\\ No newline")) continue;
      const prefix = line[0],
        body = line.slice(1);
      if (prefix === " " || prefix === "-") {
        if (oldRemaining-- <= 0) throw new Error("Invalid diff old range");
        current.old[oldLine++] = body;
      }
      if (prefix === " " || prefix === "+") {
        if (newRemaining-- <= 0) throw new Error("Invalid diff new range");
        current.new[newLine++] = body;
      }
      if (![" ", "-", "+"].includes(prefix))
        throw new Error("Invalid diff line");
      continue;
    }
    if (line.startsWith("--- ")) {
      current.oldPath = name(line.slice(4), "a/");
      continue;
    }
    if (line.startsWith("+++ ")) {
      current.newPath = name(line.slice(4), "b/");
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.oldPath = path.resolve(repoRoot, gitName(line.slice(12)));
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.newPath = path.resolve(repoRoot, gitName(line.slice(10)));
      continue;
    }
    if (line.startsWith("@@")) {
      if (oldRemaining || newRemaining) throw new Error("Incomplete diff hunk");
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) throw new Error("Unsupported diff hunk");
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      oldRemaining = Number(match[2] ?? 1);
      newRemaining = Number(match[4] ?? 1);
      continue;
    }
  }
  if (oldRemaining || newRemaining) throw new Error("Incomplete diff hunk");
  return files;
}
export async function capture(
  target: Target,
  roots: string[],
): Promise<{ target: Target; snapshot: Snapshot }> {
  let text: string,
    base: string | null = null,
    head: string | null = null,
    files: DiffFile[] = [];
  if (target.kind === "document") {
    if (!path.isAbsolute(target.path))
      throw new Error("Review document path must be absolute");
    const canonical = await realpath(target.path);
    const canonicalRoots = await Promise.all(
      roots.map((root) => realpath(root)),
    );
    if (!canonicalRoots.some((root) => inside(root, canonical)))
      throw new Error("Review document is outside workspace");
    const handle = await open(canonical, "r");
    try {
      if (!(await handle.stat()).isFile())
        throw new Error("Review target is not a file");
      const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
      let used = 0;
      while (used < buffer.length) {
        const read = await handle.read(
          buffer,
          used,
          buffer.length - used,
          used,
        );
        if (!read.bytesRead) break;
        used += read.bytesRead;
      }
      if (used > 2 * 1024 * 1024)
        throw new Error("Review document exceeds 2 MiB");
      if (buffer.subarray(0, used).includes(0))
        throw new Error("Binary document cannot be reviewed");
      text = new TextDecoder("utf8", { fatal: true }).decode(
        buffer.subarray(0, used),
      );
    } finally {
      await handle.close();
    }
    target = { kind: "document", path: canonical };
  } else {
    const project = new ProjectService({ roots });
    const diff = await project.diff(target);
    if (diff.truncated || Buffer.byteLength(diff.patch) > 8 * 1024 * 1024)
      throw new Error("Incomplete diff cannot be reviewed");
    text = diff.patch;
    if (text.includes("\0") || text.includes("\ufffd"))
      throw new Error("Binary or invalid UTF-8 diff");
    base = diff.base;
    head = diff.head;
    target = { ...target, repoRoot: diff.repoRoot };
    files = manifest(text, diff.repoRoot);
  }
  return {
    target,
    snapshot: {
      id: randomUUID(),
      kind: target.kind,
      hash: hash(text),
      text,
      base,
      head,
      files,
    },
  };
}
export interface Range {
  startLine: number;
  endLine: number;
  path?: string;
  side?: "old" | "new";
}
export interface Anchor {
  snapshotId: string;
  path: string;
  startLine: number;
  endLine: number;
  selectedTextHash: string;
  side?: "old" | "new";
}
export function anchor(
  snapshot: Snapshot,
  target: Target,
  range: Range,
): { anchor: Anchor; quote: string } {
  if (
    !Number.isInteger(range.startLine) ||
    !Number.isInteger(range.endLine) ||
    range.startLine < 1 ||
    range.endLine < range.startLine ||
    range.endLine - range.startLine > 2 * 1024 * 1024
  )
    throw new Error("Invalid comment line range");
  let values: string[], file: string;
  if (target.kind === "document") {
    if (range.side || (range.path && range.path !== target.path))
      throw new Error("Invalid document anchor");
    file = target.path;
    const saved = lines(snapshot.text);
    if (range.endLine > saved.length)
      throw new Error("Line is outside saved document");
    values = saved.slice(range.startLine - 1, range.endLine);
  } else {
    if (!range.path || !["old", "new"].includes(range.side ?? ""))
      throw new Error("Diff path and side required");
    file = range.path;
    const side = range.side!;
    const entry = snapshot.files.find(
      (entry) => (side === "old" ? entry.oldPath : entry.newPath) === file,
    );
    if (!entry) throw new Error("Path is absent on saved diff side");
    values = [];
    for (let line = range.startLine; line <= range.endLine; line++) {
      if (!Object.hasOwn(entry[side], line))
        throw new Error("Anchor crosses absent diff lines");
      values.push(entry[side][line]);
    }
  }
  const quote = values.join("\n");
  return {
    quote,
    anchor: {
      snapshotId: snapshot.id,
      path: file,
      startLine: range.startLine,
      endLine: range.endLine,
      selectedTextHash: hash(quote),
      ...(range.side ? { side: range.side } : {}),
    },
  };
}
