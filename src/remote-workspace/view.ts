import type { AppState, OperationRequest } from "../types";

const workspaceOperations = new Set([
  "workspace.focus",
  "workspace.rename",
  "workspace.add-folder",
  "workspace.remove-folder",
  "workspace.settings",
]);
const groupOperations = new Set([
  "group.ensure",
  "group.split",
  "group.focus",
  "group.visibility",
  "group.toggle-split",
  "group.resize",
]);
const paneOperations = new Set([
  "pane.new",
  "pane.split",
  "pane.move",
  "pane.focus",
  "pane.reopen",
  "pane.pin",
  "pane.close",
  "pane.close-many",
]);
const fileOperations = new Set([
  "file.new",
  "file.open",
  "file.read",
  "file.save",
  "file.save-as",
  "file.draft",
  "file.lines",
  "file.version",
  "file.resolve",
  "project.list",
  "project.search",
  "git.repositories",
  "git.changes",
]);
const terminalOperations = new Set([
  "terminal.open",
  "terminal.inspect",
  "terminal.write",
  "terminal.resize",
  "terminal.close",
]);
const chatOperations = new Set([
  "conversation.draft",
  "conversation.composer",
  "conversation.discover",
  "conversation.start",
  "conversation.create",
  "conversation.resume",
  "conversation.show",
  "conversation.options",
  "conversation.option",
  "conversation.send",
  "conversation.interrupt",
  "conversation.queue-edit",
  "conversation.queue-remove",
  "conversation.queue-resume",
  "conversation.rename",
  "conversation.acknowledge",
  "conversation.inspect",
  "conversation.earlier-history",
]);

export function requestBelongsToHost(
  state: AppState,
  request: OperationRequest,
): boolean {
  if (typeof request.workspace === "string")
    return state.workspaces.some(
      (workspace) => workspace.id === request.workspace,
    );
  if (request.op.startsWith("workspace."))
    return state.workspaces.some((workspace) => workspace.id === request.id);
  if (request.op.startsWith("terminal."))
    return state.terminals.some((terminal) => terminal.id === request.id);
  if (request.op.startsWith("conversation."))
    return state.conversations.some((chat) => chat.id === request.id);
  if (request.op.startsWith("review."))
    return state.reviews?.some((review) => review.id === request.id) ?? false;
  return false;
}

export function validateRemoteRequest(request: OperationRequest): void {
  if (
    ![
      workspaceOperations,
      groupOperations,
      paneOperations,
      fileOperations,
      terminalOperations,
      chatOperations,
    ].some((operations) => operations.has(request.op))
  )
    throw new Error("This action is unavailable in a Linux workspace");
  if (
    request.op.startsWith("conversation.") &&
    typeof request.provider === "string" &&
    request.provider !== "codex"
  )
    throw new Error("This Linux workspace connection supports Codex");
}

export function combineWorkspaces(
  local: AppState,
  host: {
    state: AppState;
    alias: string;
    connected: boolean;
    reviewAccess: boolean;
    viewing?: string;
  },
): AppState {
  const { state, alias, connected, reviewAccess, viewing } = host;
  if (
    state.workspaces.some((workspace) =>
      local.workspaces.some((item) => item.id === workspace.id),
    )
  )
    throw new Error("This host contains a workspace already open locally");
  return {
    ...local,
    workspaces: [...local.workspaces, ...state.workspaces],
    activeWorkspaceId:
      viewing && state.workspaces.some((workspace) => workspace.id === viewing)
        ? viewing
        : local.activeWorkspaceId,
    conversations: [...local.conversations, ...state.conversations],
    terminals: [...local.terminals, ...state.terminals],
    reviews: [...(local.reviews ?? []), ...(state.reviews ?? [])],
    reviewPresentation: viewing
      ? state.reviewPresentation
      : local.reviewPresentation,
    remoteWorkspace: {
      alias,
      connected,
      reviewAccess,
      ids: state.workspaces.map((workspace) => workspace.id),
    },
  };
}
