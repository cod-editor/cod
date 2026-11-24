import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppState } from "../../src/types.ts";
import {
  createWorkspaceRecords,
  workspaceDatabaseFile,
  workspaceDatabaseVersion,
  workspaceRows,
  workspaceState,
  type ArchivedWorkspace,
  type WorkspaceRow,
} from "../../src/application/sqlite-state-rows.ts";

export function openWorkspaceState(directory: string, readOnly = false) {
  const db = new DatabaseSync(path.join(directory, workspaceDatabaseFile), {
    readOnly,
  });
  db.exec("PRAGMA busy_timeout=5000");
  if (!readOnly && db.prepare("PRAGMA user_version").get()!.user_version === 0)
    db.exec(
      `${createWorkspaceRecords} PRAGMA user_version=${workspaceDatabaseVersion};`,
    );
  return db;
}

export function readWorkspaceState(directory: string): AppState {
  using db = openWorkspaceState(directory, true);
  const rows = db
    .prepare(
      "SELECT kind, id, body, position FROM records ORDER BY kind, position, id",
    )
    .all()
    .map(({ kind, id, body, position }) => ({
      kind: String(kind),
      id: String(id),
      body: JSON.parse(String(body)),
      position: Number(position),
    }));
  const state = workspaceState(rows) as AppState;
  const archives = new Map(
    rows
      .filter((row) => row.kind === "archive")
      .map((row) => [row.id, row.body as ArchivedWorkspace]),
  );
  if (state.closedWorkspaces?.length)
    state.closedWorkspaces = state.closedWorkspaces.map(({ workspace }) =>
      archives.get(workspace.id)!,
    );
  return state;
}

export function writeWorkspaceState(directory: string, state: AppState): void {
  using db = openWorkspaceState(directory);
  const insert = db.prepare(
    "INSERT INTO records(kind, id, position, body) VALUES(?, ?, ?, ?)",
  );
  const rows: WorkspaceRow[] = workspaceRows(state, "all");
  state.closedWorkspaces?.forEach((archive, position) =>
    rows.push({
      kind: "archive",
      id: archive.workspace.id,
      position,
      body: archive,
    }),
  );
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec("DELETE FROM records;");
    for (const { kind, id, body, position } of rows)
      insert.run(kind, id, position, JSON.stringify(body));
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
