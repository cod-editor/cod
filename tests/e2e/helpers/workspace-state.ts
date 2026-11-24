import { workspacePaneRowId } from "../../../src/application/sqlite-state-rows";
import { openWorkspaceState } from "../../support/workspace-state";

export function readWorkspaceChatDraftBody(
  directory: string,
  workspace: string,
  pane: string,
): string | undefined {
  using db = openWorkspaceState(directory, true);
  const row = db
    .prepare("SELECT body FROM records WHERE kind = 'draft-chat' AND id = ?")
    .get(workspacePaneRowId(workspace, pane));
  return typeof row?.body === "string" ? row.body : undefined;
}
