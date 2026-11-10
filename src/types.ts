import type {
  PermissionOption,
  ProviderId,
  ProviderState,
} from "./providers/types";

export type SplitDirection = "right" | "down";

export interface DocumentPane {
  id: string;
  kind: "document";
  draftChat?: boolean;
  filePath?: string;
  canonicalPath?: string;
  line?: number;
}

export interface ConversationPane {
  id: string;
  kind: "conversation";
  conversationId: string;
}

export interface TerminalPane {
  id: string;
  kind: "terminal";
  terminalId: string;
}

export interface BrowserPane {
  id: string;
  kind: "browser";
  browserId: string;
}
export interface BrowserState {
  permissionDenied?: string;
  agentPage?: {
    path: string;
    conversationId: string;
    error?: string;
    submission?: {
      id: string;
      payload: unknown;
      status: "sending" | "completed" | "uncertain";
    };
  };
  lastSuccessfulUrl?: string;
  nativeTabId?: number;
  addons?: import("./browser-addons").AddonStatus;
  id: string;
  paneId: string;
  workspaceId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  visible: boolean;
  error?: string;
  download?: { basename: string; status: string; path?: string };
}
export interface BrowserRectangle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface EmptyPane {
  id: string;
  kind: "empty";
}
export type PaneState =
  | EmptyPane
  | DocumentPane
  | ConversationPane
  | TerminalPane
  | BrowserPane
  | PreviewPane
  | DiffPane
  | ReviewPane;

export interface ReviewPane {
  id: string;
  kind: "review";
  reviewId: string;
}
export type ReviewSummary = Awaited<
  ReturnType<import("./reviews/index").ReviewService["inspect"]>
>;

export interface PreviewPane {
  id: string;
  kind: "preview";
  filePath: string;
}
export interface DiffPane {
  id: string;
  kind: "diff";
  repoRoot: string;
  base?: string;
  head?: string;
}
export interface FileDraft {
  content: string;
  expectedContent: string;
}

export interface ConversationMessage {
  images?: import("./providers/types").ImageAttachment[];
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  order: number;
  origin?: "application";
}

export interface ToolActivity {
  id: string;
  phase: "started" | "updated" | "completed";
  details: unknown;
  order: number;
}

export interface PendingPermission {
  id: string;
  options: PermissionOption[];
  details: unknown;
}

export interface ConversationState {
  handoffTerminalId?: string;
  taskStatus?: "working" | "waiting" | "review" | "ready" | "failed";
  taskStatusContext?: string;
  taskStatusUpdatedAt?: string;
  taskStatusAcknowledgedAt?: string;
  completionRevision?: number;
  acknowledgedCompletionRevision?: number;
  id: string;
  paneId: string;
  workspaceId: string;
  provider: ProviderId;
  nativeId: string;
  cwd: string;
  status: ProviderState;
  messages: ConversationMessage[];
  tools: ToolActivity[];
  pendingPermissions: PendingPermission[];
  metadata?: unknown;
  error?: string;
  historyPartial?: boolean;
}

export interface TerminalState {
  nativeConversationId?: string;
  id: string;
  paneId: string;
  workspaceId: string;
  cwd: string;
  status: "starting" | "running" | "exited" | "failed";
  pid: number;
  cols: number;
  rows: number;
  output: string;
  sequence: number;
  exitCode?: number;
  error?: string;
}

export interface TerminalUiEvent {
  terminalId: string;
  sequence: number;
  type: "data" | "exit" | "error";
  data?: string;
  message?: string;
}

export type Layout =
  | { type: "leaf"; paneId: string }
  | {
      type: "split";
      direction: SplitDirection;
      ratio: number;
      first: Layout;
      second: Layout;
    };

export interface TabGroup {
  id: string;
  paneIds: string[];
  activePaneId: string;
  hidden?: boolean;
}
export interface WorkspaceSettings {
  filesVisible?: boolean;
  workspacesVisible?: boolean;
  chatMaxWidth?: number;
  workspacesWidth?: number;
  filesWidth?: number;
}
export interface WorkspaceState {
  closedTabs?: Array<{
    pane: PaneState;
    browser?: BrowserState;
    terminal?: TerminalState;
  }>;
  chatDrafts?: Record<
    string,
    {
      text: string;
      provider?: ProviderId;
      skills?: Array<{ name: string; path: string }>;
      images?: import("./providers/types").ImageAttachment[];
    }
  >;
  lastConversationId?: string;
  groups?: TabGroup[];
  groupLayout?: Layout;
  activeGroupId?: string;
  zoomedGroupId?: string | null;
  settings?: WorkspaceSettings;
  id: string;
  name: string;
  folders: string[];
  panes: PaneState[];
  activePaneId: string;
  layout: Layout;
}

export interface AppState {
  closedWorkspaces?: Array<{
    workspace: WorkspaceState;
    conversations: ConversationState[];
    terminals: TerminalState[];
    browsers: BrowserState[];
  }>;
  workspaces: WorkspaceState[];
  activeWorkspaceId: string | null;
  conversations: ConversationState[];
  terminals: TerminalState[];
  browsers: BrowserState[];
  drafts: Record<string, FileDraft>;
  reviews?: ReviewSummary[];
}

export interface OperationRequest {
  op: string;
  [key: string]: unknown;
}

export interface CodBridge {
  chooseDirectory(): Promise<string | null>;
  invoke<T = unknown>(request: OperationRequest): Promise<T>;
  onState(callback: (state: AppState) => void): void;
  browserLayout(rectangles: BrowserRectangle[]): void;
  browserSelect(id: string): void;
  onBrowserShortcut(
    callback: (event: {
      id: string;
      action: "palette" | "panel" | "address" | "close" | "settings";
    }) => void,
  ): void;
  onTerminal(callback: (event: TerminalUiEvent) => void): void;
}
