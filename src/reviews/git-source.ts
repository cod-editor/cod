import path from "node:path";
import { diffHunks, type DiffHunk, type DiffRow } from "../diff-hunks.ts";
import { ProjectService } from "../projects/index.ts";
import type { Snapshot } from "./snapshots.ts";

export interface ReviewedGitFile {
  oldPath: string | null;
  newPath: string | null;
  rows: DiffRow[];
  complete: boolean;
}

export interface ReviewedGitEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
}

const MAX_SOURCE_LINES = 20_000;

function relativeTo(root: string, file: string, allowRoot = false): string {
  const relative = path.relative(root, file);
  if (
    !path.isAbsolute(file) ||
    (!relative && !allowRoot) ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error("Path is outside saved review repository");
  return relative;
}

function sourceLines(text: string): string[] {
  const result = text.split("\n");
  if (result.at(-1) === "") result.pop();
  if (result.length > MAX_SOURCE_LINES)
    throw new Error("Saved review source has too many lines");
  return result;
}

export function wholeFileRows(before: string[], hunks: DiffHunk[]): DiffRow[] {
  const result: DiffRow[] = [];
  let oldLine = 1,
    newLine = 1;
  function copyUntil(limit: number) {
    if (limit < oldLine || limit > before.length + 1)
      throw new Error("Saved diff hunk does not match its old revision");
    while (oldLine < limit)
      result.push({
        kind: "context",
        oldLine,
        newLine: newLine++,
        text: before[oldLine++ - 1],
      });
  }
  for (const hunk of hunks) {
    const offset = /^@@ -(\d+)(?:,(\d+))? /.exec(hunk.header);
    if (!offset) throw new Error("Malformed saved diff coordinates");
    copyUntil(Number(offset[1]) + Number(offset[2] === "0"));
    for (const row of hunk.rows) {
      if (
        row.oldLine !== undefined &&
        (row.oldLine !== oldLine || row.text !== before[oldLine++ - 1])
      )
        throw new Error("Saved diff text does not match its old revision");
      if (row.newLine !== undefined && row.newLine !== newLine++)
        throw new Error("Saved diff hunk does not match its new revision");
      result.push(row);
    }
  }
  copyUntil(before.length + 1);
  if (result.length > MAX_SOURCE_LINES)
    throw new Error("Saved review source has too many lines");
  return result;
}

export async function reviewedGitTree(
  snapshot: Snapshot,
  root: string,
  roots: string[],
  directory: string,
): Promise<ReviewedGitEntry[]> {
  const relative = relativeTo(root, directory, true);
  const entries = new Map<string, ReviewedGitEntry>();
  const pending = snapshot.head ?? snapshot.workingBase;
  if (pending) {
    try {
      for (const entry of await new ProjectService({ roots }).listReviewTree(
        root,
        pending,
        relative,
      ))
        entries.set(entry.name, {
          ...entry,
          path: path.join(directory, entry.name),
        });
    } catch {
      // A directory added by the working patch need not exist in the base tree.
      // If saved Git objects are missing, files from the recorded patch remain available.
    }
  }
  for (const file of snapshot.files) {
    if (
      file.oldPath &&
      file.newPath &&
      file.oldPath !== file.newPath &&
      path.dirname(file.oldPath) === directory
    )
      entries.delete(path.basename(file.oldPath));
    const target = file.newPath ?? file.oldPath;
    if (!target) continue;
    const relative = path.relative(directory, target);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    )
      continue;
    const [name, ...parent] = relative.split(path.sep);
    entries.set(name, {
      name,
      path: path.join(directory, name),
      kind: parent.length ? "directory" : "file",
    });
  }
  return [...entries.values()].sort(
    (a, b) =>
      Number(b.kind === "directory") - Number(a.kind === "directory") ||
      a.name.localeCompare(b.name),
  );
}

export async function reviewedGitFile(
  snapshot: Snapshot,
  root: string,
  roots: string[],
  filePath: string,
  side?: "old" | "new",
): Promise<ReviewedGitFile> {
  relativeTo(root, filePath);
  const index = snapshot.files.findIndex((entry) =>
    side === "old"
      ? entry.oldPath === filePath
      : side === "new"
        ? entry.newPath === filePath
        : (entry.newPath ?? entry.oldPath) === filePath,
  );
  if (
    index === -1 &&
    snapshot.files.some(
      (entry) => entry.oldPath === filePath || entry.newPath === filePath,
    )
  )
    throw new Error("Path is absent on saved diff side");
  const file = snapshot.files[index] ?? {
    oldPath: filePath,
    newPath: filePath,
  };
  const { oldPath, newPath } = file;
  const hunks = index === -1 ? [] : (diffHunks(snapshot.text)[index] ?? []);
  try {
    const project = new ProjectService({ roots });
    const read = (revision: string, absolute: string) =>
      project
        .readReviewBlob(root, revision, relativeTo(root, absolute))
        .then(sourceLines);
    const current =
      (side === "old" ? snapshot.base : snapshot.head) ?? snapshot.workingBase;
    if (index === -1 && current) {
      const text = await read(current, filePath);
      return {
        oldPath,
        newPath,
        rows: wholeFileRows(text, []),
        complete: true,
      };
    }
    const before = snapshot.base ?? snapshot.workingBase;
    if (oldPath && !before)
      throw new Error("Saved old Git source is unavailable");
    if (index === -1) throw new Error("Saved Git source is unavailable");
    const rows = wholeFileRows(
      oldPath && before ? await read(before, oldPath) : [],
      hunks,
    );
    if (snapshot.head && newPath) {
      const expected = await read(snapshot.head, newPath);
      const actual = rows.filter(({ newLine }) => newLine !== undefined);
      if (
        actual.length !== expected.length ||
        actual.some(({ text }, line) => text !== expected[line])
      )
        throw new Error("Saved patch does not match its new revision");
    }
    return { oldPath, newPath, rows, complete: true };
  } catch {
    return {
      oldPath,
      newPath,
      rows: hunks.flatMap(({ rows }) => rows),
      complete: false,
    };
  }
}
