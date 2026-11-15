/** Presentation of an already validated saved Git diff; paths come from its manifest. */
export interface DiffRow {
  kind: "context" | "removed" | "added";
  text: string;
  oldLine?: number;
  newLine?: number;
  noNewline?: boolean;
}
export interface DiffHunk {
  header: string;
  rows: DiffRow[];
}
export function diffHunks(text: string): DiffHunk[][] {
  const files: DiffHunk[][] = [];
  let file: DiffHunk[] | undefined, hunk: DiffHunk | undefined;
  let oldLine = 0,
    newLine = 0,
    oldRemaining = 0,
    newRemaining = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = [];
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      oldRemaining = Number(match[2] ?? 1);
      newRemaining = Number(match[4] ?? 1);
      hunk = { header: line, rows: [] };
      file.push(hunk);
      continue;
    }
    if (line.startsWith("\\ No newline") && hunk?.rows.length) {
      hunk.rows.at(-1)!.noNewline = true;
      continue;
    }
    if (!hunk || (!oldRemaining && !newRemaining)) continue;
    const row: DiffRow = {
      kind: line[0] === "-" ? "removed" : line[0] === "+" ? "added" : "context",
      text: line.slice(1),
    };
    if (line[0] === " " || line[0] === "-") {
      row.oldLine = oldLine++;
      oldRemaining--;
    }
    if (line[0] === " " || line[0] === "+") {
      row.newLine = newLine++;
      newRemaining--;
    }
    hunk.rows.push(row);
  }
  return files;
}
