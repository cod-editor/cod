import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** Bounded local metadata journal. Callers must never pass content or arbitrary errors. */
export class DiagnosticJournal {
  readonly directory: string;
  private failed = false;
  private readonly limit: number;
  constructor(root: string, limit = 1_048_576) {
    this.limit = limit;
    this.directory = path.join(root, "diagnostics");
  }
  record(event: string, metadata: Record<string, unknown> = {}): void {
    if (this.failed) return;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, "runtime.jsonl");
      const line =
        JSON.stringify({ time: new Date().toISOString(), event, ...metadata }) +
        "\n";
      if (Buffer.byteLength(line) > this.limit) return;
      if (this.size(file) + Buffer.byteLength(line) > this.limit) {
        rmSync(file + ".3", { force: true });
        for (const [from, to] of [
          [".2", ".3"],
          [".1", ".2"],
          ["", ".1"],
        ])
          if (this.size(file + from)) renameSync(file + from, file + to);
      }
      appendFileSync(file, line, { mode: 0o600 });
    } catch {
      this.failed = true;
      console.error("Cod local diagnostics unavailable");
    }
  }
  start(version: string): void {
    try {
      const previous = JSON.parse(
        readFileSync(path.join(this.directory, "session.json"), "utf8"),
      );
      if (!previous.clean)
        this.record("previous-session-unfinished", {
          pid: previous.pid,
          started: previous.started,
        });
    } catch {
      /* First run or unavailable marker. */
    }
    this.marker(false);
    this.record("start", {
      pid: process.pid,
      version,
      platform: process.platform,
      arch: process.arch,
    });
  }
  stop(): void {
    this.record("shutdown");
    this.marker(true);
  }
  private marker(clean: boolean): void {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, "session.json");
      writeFileSync(
        file + ".tmp",
        JSON.stringify({
          pid: process.pid,
          started: new Date().toISOString(),
          clean,
        }),
        { mode: 0o600 },
      );
      renameSync(file + ".tmp", file);
    } catch {
      /* Diagnostics must not prevent startup or shutdown. */
    }
  }
  private size(file: string): number {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  }
}
