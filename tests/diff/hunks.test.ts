import { test } from "node:test";
import assert from "node:assert/strict";
import { diffHunks } from "../../src/diff-hunks.ts";
test("unified diff keeps context once, changed sides, hunk boundaries and missing newlines", () => {
  const files = diffHunks(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 unchanged
-old
+new
 trailing
@@ -20 +20,2 @@ section
 another
+addition
\\ No newline at end of file
diff --git a/b.txt b/b.txt
--- /dev/null
+++ b/b.txt
@@ -0,0 +1 @@
+created
`);
  assert.equal(files.length, 2);
  assert.equal(files[0].length, 2);
  assert.deepEqual(files[0][0].rows, [
    { kind: "context", text: "unchanged", oldLine: 1, newLine: 1 },
    { kind: "removed", text: "old", oldLine: 2 },
    { kind: "added", text: "new", newLine: 2 },
    { kind: "context", text: "trailing", oldLine: 3, newLine: 3 },
  ]);
  assert.equal(files[0][1].rows[1].newLine, 21);
  assert.equal(files[0][1].rows[1].noNewline, true);
  assert.deepEqual(files[1][0].rows[0], {
    kind: "added",
    text: "created",
    newLine: 1,
  });
});
