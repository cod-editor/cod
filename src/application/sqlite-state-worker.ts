import { parentPort, workerData } from "node:worker_threads";
import { existsSync, closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  createWorkspaceRecords,
  workspaceDatabaseVersion,
  workspaceRecordKinds,
  type WorkspaceRow,
} from "./sqlite-state-rows.ts";

export type WorkspaceDatabaseRequest =
  | { operation: "load" }
  | { operation: "read"; kind: "archive" | "closed-chat"; id: string }
  | {
      operation: "save";
      rows: WorkspaceRow[];
      scope: "all" | "layout" | "partial";
    }
  | { operation: "close" };

function start() {
  // SQLite follows the DB file's permissions for its journal and WAL files.
  const file = workerData as string;
  if (!existsSync(file)) {
    try {
      closeSync(openSync(file, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=2000;");
    db.exec("BEGIN IMMEDIATE;");
    const { user_version: version } = db.prepare("PRAGMA user_version").get()!;
    if (version === 0) {
      db.exec(createWorkspaceRecords);
      db.exec(`PRAGMA user_version=${workspaceDatabaseVersion};`);
    } else if (version !== workspaceDatabaseVersion) {
      throw new Error("Unsupported workspace database version");
    }
    db.exec("COMMIT;");
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const db = start();
const list = db.prepare(
  "SELECT kind, id, position, body FROM records WHERE kind NOT IN ('archive', 'closed-chat') ORDER BY kind, position, id",
);
const read = db.prepare("SELECT body FROM records WHERE kind=? AND id=?");
const existing = db.prepare("SELECT id FROM records WHERE kind=?");
const remove = db.prepare("DELETE FROM records WHERE kind=? AND id=?");
const update = db.prepare(`
  INSERT INTO records(kind, id, position, body) VALUES (?, ?, ?, ?)
  ON CONFLICT(kind,id) DO UPDATE SET position=excluded.position, body=excluded.body
  WHERE records.position <> excluded.position OR records.body <> excluded.body
`);

function handle(request: WorkspaceDatabaseRequest) {
  if (request.operation === "load")
    return list
      .all()
      .map(({ body, ...row }) => ({ ...row, body: JSON.parse(String(body)) }));
  if (request.operation === "read") {
    const row = read.get(request.kind, request.id);
    return row && JSON.parse(String(row.body));
  }
  if (request.operation === "close") {
    db.close();
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const ids = new Map<string, Set<string>>();
    for (const { kind, id, body, position } of request.rows) {
      if (body === undefined) remove.run(kind, id);
      else update.run(kind, id, position, JSON.stringify(body));
      if (request.scope !== "partial") {
        if (!ids.has(kind)) ids.set(kind, new Set());
        ids.get(kind)!.add(id);
      }
    }
    if (request.scope !== "partial") {
      const kinds =
        request.scope === "layout"
          ? ["meta", "workspace"]
          : workspaceRecordKinds;
      for (const kind of kinds) {
        if (kind === "archive" || kind === "closed-chat") continue;
        const present = ids.get(kind);
        for (const { id } of existing.all(kind)) {
          if (!present?.has(String(id))) {
            remove.run(kind, id);
            if (kind === "archive-summary") remove.run("archive", id);
            if (kind === "closed-tab") remove.run("closed-chat", id);
          }
        }
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

parentPort!.on(
  "message",
  ({ id, request }: { id: number; request: WorkspaceDatabaseRequest }) => {
    try {
      parentPort!.postMessage({ id, value: handle(request) });
    } catch (error) {
      parentPort!.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
