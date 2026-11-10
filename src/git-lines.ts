import path from "node:path";
function decode(value: string): string {
  if (!value.startsWith('"')) return value.split("\t")[0];
  const quoted = value.match(/^"((?:\\.|[^"\\])*)"/);
  if (!quoted) return value;
  const bytes: number[] = [];
  const source = quoted[1];
  for (let i = 0; i < source.length;) {
    if (source[i] !== "\\") {
      const point = String.fromCodePoint(source.codePointAt(i)!);
      bytes.push(...Buffer.from(point));
      i += point.length;
      continue;
    }
    const octal = source.slice(i + 1).match(/^[0-7]{1,3}/);
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += octal[0].length + 1;
    } else {
      const char = source[++i];
      bytes.push(
        ...Buffer.from(
          (
            { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" } as Record<
              string,
              string
            >
          )[char] ?? char,
        ),
      );
      i++;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
export function changedLines(
  patch: string,
  repoRoot: string,
  filePath: string,
): number[] {
  let selected = false,
    line = 0,
    inHunk = false;
  const changed = new Set<number>();
  for (const row of patch.split("\n")) {
    if (row.startsWith("diff --git ")) {
      selected = false;
      inHunk = false;
    }
    if (!inHunk && row.startsWith("+++ ")) {
      const name = decode(row.slice(4));
      selected =
        name.startsWith("b/") &&
        path.resolve(repoRoot, name.slice(2)) === filePath;
      inHunk = false;
      continue;
    }
    if (!selected) continue;
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (row.startsWith("+")) changed.add(line++);
    else if (row.startsWith("-")) changed.add(Math.max(1, line));
    else if (row.startsWith(" ")) line++;
  }
  return [...changed].sort((a, b) => a - b);
}
