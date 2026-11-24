import type { AppState, ConversationState, WorkspaceState } from "../types.ts";

export const workspaceDatabaseFile = "workspace.sqlite";
export const workspaceDatabaseVersion = 1;
export const createWorkspaceRecords = `
  CREATE TABLE records(
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    position INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY(kind,id)
  ) STRICT, WITHOUT ROWID;
`;

export type ArchivedWorkspace = NonNullable<
  AppState["closedWorkspaces"]
>[number];

export type ClosedTab = NonNullable<WorkspaceState["closedTabs"]>[number];

export interface WorkspaceRow {
  kind: string;
  id: string;
  position: number;
  body: unknown;
}

export const workspaceRecordKinds = [
  "meta",
  "workspace",
  "draft-chat",
  "draft-images",
  "draft-local-images",
  "closed-tab",
  "closed-chat",
  "conversation",
  "terminal",
  "browser",
  "draft-file",
  "archive",
  "archive-summary",
] as const;

export function workspacePaneRowId(workspace: string, pane: string) {
  return JSON.stringify([workspace, pane]);
}

type ChatDraft = NonNullable<WorkspaceState["chatDrafts"]>[string];

export function chatDraftRows(
  id: string,
  draft?: ChatDraft,
  previous?: ChatDraft,
): WorkspaceRow[] {
  const { images, localDraft, ...text } = draft ?? { text: "" };
  const { images: localImages, ...localText } = localDraft ?? { text: "" };
  const create = (kind: string, body: unknown) => ({
    kind,
    id,
    position: 0,
    body,
  });
  const rows = [
    create(
      "draft-chat",
      draft && { ...text, localDraft: localDraft && localText },
    ),
  ];
  if (images !== previous?.images) rows.push(create("draft-images", images));
  if (localImages !== previous?.localDraft?.images)
    rows.push(create("draft-local-images", localImages));
  return rows;
}

export function workspaceLayout(workspace: WorkspaceState) {
  const { chatDrafts: _drafts, closedTabs: _closed, ...layout } = workspace;
  return layout;
}

export function archiveSummary(record: ArchivedWorkspace): ArchivedWorkspace {
  return {
    workspace: {
      ...workspaceLayout(record.workspace),
      closedTabs: record.workspace.closedTabs?.map(
        ({ pane, groupId, index, collapsedSplit }) => ({
          pane,
          groupId,
          index,
          collapsedSplit,
        }),
      ),
    },
    conversations: [],
    terminals: record.terminals.map(
      ({ output: _output, error: _error, ...terminal }) => ({
        ...terminal,
        output: "",
      }),
    ),
    browsers: [],
  };
}

export function workspaceRows(
  state: AppState,
  scope: "layout" | "all",
): WorkspaceRow[] {
  const {
    activeWorkspaceId,
    workspaces,
    conversations,
    terminals,
    browsers,
    drafts,
    closedWorkspaces,
    pinnedSites,
    browserDownloads,
    sitePermissions,
    reviews,
    transferredCodexSessions,
    pendingCodexImports,
    completedCodexImports,
  } = state;
  const rows: WorkspaceRow[] = [];
  const add = (kind: string, id: string, body: unknown, position = 0) =>
    rows.push({ kind, id, body, position });
  add("meta", "state", {
    activeWorkspaceId,
    pinnedSites,
    browserDownloads,
    sitePermissions,
    reviews,
    transferredCodexSessions,
    pendingCodexImports,
    completedCodexImports,
  });
  workspaces.forEach((workspace, position) => {
    add("workspace", workspace.id, workspaceLayout(workspace), position);
    if (scope === "layout") return;
    for (const [pane, draft] of Object.entries(workspace.chatDrafts ?? {}))
      rows.push(
        ...chatDraftRows(workspacePaneRowId(workspace.id, pane), draft),
      );
    workspace.closedTabs?.forEach(({ conversation, ...tab }, index) => {
      const id = workspacePaneRowId(workspace.id, tab.pane.id);
      add("closed-tab", id, tab, index);
      if (conversation) add("closed-chat", id, conversation);
    });
  });
  if (scope === "layout") return rows;
  for (const [kind, items] of [
    ["conversation", conversations],
    ["terminal", terminals],
    ["browser", browsers],
  ] as const)
    items.forEach((item, index) => add(kind, item.id, item, index));
  for (const [id, draft] of Object.entries(drafts))
    add("draft-file", id, draft);
  closedWorkspaces?.forEach((archive, index) =>
    add(
      "archive-summary",
      archive.workspace.id,
      archiveSummary(archive),
      index,
    ),
  );
  return rows;
}

export function workspaceState(rows: WorkspaceRow[]): Partial<AppState> {
  const list = <T>(kind: string): T[] =>
    rows.filter((row) => row.kind === kind).map((row) => row.body as T);
  const meta = list<Partial<AppState>>("meta")[0];
  if (!meta) {
    if (rows.length) throw new Error("Workspace database has missing metadata");
    return {};
  }
  const workspaces = list<WorkspaceState>("workspace");
  const workspaceById = new Map(
    workspaces.map((workspace) => [workspace.id, workspace]),
  );
  const draftParts = new Map(
    rows
      .filter(
        (row) =>
          row.kind === "draft-images" || row.kind === "draft-local-images",
      )
      .map((row) => [
        JSON.stringify([row.kind, row.id]),
        row.body as ChatDraft["images"],
      ]),
  );
  const closedChats = new Map(
    rows
      .filter(({ kind }) => kind === "closed-chat")
      .map(({ id, body }) => [id, body as ConversationState]),
  );
  for (const row of rows) {
    if (row.kind !== "draft-chat" && row.kind !== "closed-tab") continue;
    const [workspaceId, paneId] = JSON.parse(row.id) as [string, string];
    const workspace = workspaceById.get(workspaceId);
    if (!workspace)
      throw new Error("Workspace database has a record without its workspace");
    if (row.kind === "draft-chat") {
      const draft = row.body as ChatDraft;
      const images = draftParts.get(JSON.stringify(["draft-images", row.id]));
      const localImages = draftParts.get(
        JSON.stringify(["draft-local-images", row.id]),
      );
      if (images) draft.images = images;
      if (localImages && draft.localDraft)
        draft.localDraft.images = localImages;
      (workspace.chatDrafts ??= {})[paneId] = draft;
    } else {
      const tab = row.body as ClosedTab;
      const conversation = closedChats.get(row.id);
      if (conversation) tab.conversation = conversation;
      (workspace.closedTabs ??= []).push(tab);
    }
  }
  return {
    ...meta,
    workspaces,
    conversations: list("conversation"),
    terminals: list("terminal"),
    browsers: list("browser"),
    closedWorkspaces: list("archive-summary"),
    drafts: Object.fromEntries(
      rows
        .filter((row) => row.kind === "draft-file")
        .map((row) => [row.id, row.body]),
    ) as AppState["drafts"],
  };
}
