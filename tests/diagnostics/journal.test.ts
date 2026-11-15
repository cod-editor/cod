import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DiagnosticJournal } from "../../src/diagnostics.ts";

test("journal bounds disk usage and distinguishes unclean from clean restarts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cod-journal-"));
  try {
    const journal = new DiagnosticJournal(root, 4096);
    journal.start("fixture");
    new DiagnosticJournal(root, 4096).start("fixture");
    assert.match(
      readFileSync(path.join(journal.directory, "runtime.jsonl"), "utf8"),
      /previous-session-unfinished/,
    );
    journal.stop();
    const before = readFileSync(
      path.join(journal.directory, "runtime.jsonl"),
      "utf8",
    );
    journal.start("fixture");
    const after = readFileSync(
      path.join(journal.directory, "runtime.jsonl"),
      "utf8",
    );
    assert.equal(
      after.split("previous-session-unfinished").length,
      before.split("previous-session-unfinished").length,
    );
    for (let i = 0; i < 1000; i++) journal.record("memory", { rss: i });
    const files = readdirSync(journal.directory).filter((name) =>
      name.startsWith("runtime"),
    );
    assert.equal(files.length, 4);
    for (const file of files) {
      assert.ok(statSync(path.join(journal.directory, file)).size <= 4096);
      for (const line of readFileSync(
        path.join(journal.directory, file),
        "utf8",
      )
        .trim()
        .split("\n"))
        assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
