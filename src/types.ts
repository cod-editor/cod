import type {
  BackgroundActivity,
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

export interface UntitledPane {
  id: string;
  kind: "untitled";
  name: string;
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
  navigation?: import("./browser/navigation").BrowserNavigation;
  permissionRequests?: import("./browser/permission-types").SiteRequest[];
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
  launcher?: boolean;
}
export type PaneState = (
  | EmptyPane
  | DocumentPane
  | UntitledPane
  | ConversationPane
  | TerminalPane
  | BrowserPane
  | PreviewPane
  | DiffPane
  | ReviewPane
) & { pinned?: boolean };

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
  format?: "image";
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
  version?: string;
}

export interface ConversationTurn {
  id: string;
  startedAt: string;
  finishedAt?: string;
  /** Observed working intervals, excluding native waiting/permission time. */
  durationMs?: number;
  elapsedMs?: number;
  outcome?: "completed" | "cancelled" | "failed";
}
export interface ConversationMessage {
  turnId?: string;
  phase?: "commentary" | "partial" | "final";
  interactive?: boolean;
  images?: import("./providers/types").ImageAttachment[];
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  order: number;
  origin?: "application";
}

export interface ToolActivity {
  turnId?: string;
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

export interface QueuedMessage {
  editing?: boolean;
  id: string;
  text: string;
  images?: import("./providers/types").ImageAttachment[];
  skills?: Array<{ name: string; path: string }>;
  status: "queued" | "sending" | "uncertain";
}

export interface ConversationState {
  initialSelection?: import("./providers/types").ProviderOptions["current"];
  queuedMessages?: QueuedMessage[];
  queuePaused?: boolean;
  displayName?: string;
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
  turns?: ConversationTurn[];
  messages: ConversationMessage[];
  tools: ToolActivity[];
  pendingPermissions: PendingPermission[];
  backgroundActivities?: BackgroundActivity[];
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
  untitledSequence?: number;
  closedTabs?: Array<{
    pane: PaneState;
    groupId?: string;
    index?: number;
    browser?: BrowserState;
    terminal?: TerminalState;
    conversation?: ConversationState;
  }>;
  chatDrafts?: Record<
    string,
    {
      text: string;
      version?: string;
      writer?: string;
      clearedFromVersion?: string;
      localDraft?: {
        text: string;
        provider?: ProviderId;
        skills?: Array<{ name: string; path: string }>;
        images?: import("./providers/types").ImageAttachment[];
      };
      provider?: ProviderId;
      initialSelection?: import("./providers/types").ProviderOptions["current"];
      cwd?: string;
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
  browserDownloads?: import("./browser/download-types").BrowserDownload[];
  sitePermissions?: import("./browser/permission-types").SitePolicy[];
  pinnedSites?: Array<{ url: string; title: string }>;
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
  /** Renderer-only navigation intent. Never written to application data. */
  reviewPresentation?: { paneId: string; token: string };
}

export interface OperationRequest {
  op: string;
  [key: string]: unknown;
}

export interface CodBridge {
  toggleDevTools(browserId?: string): Promise<void>;
  onSettings(
    callback: (state: import("./settings").SettingsState) => void,
  ): void;
  openSettings(): Promise<void>;
  getKeymap(): Promise<import("./keyboard").KeymapState>;
  onKeymap(callback: (state: import("./keyboard").KeymapState) => void): void;
  openKeymap(): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  chooseSaveFile(
    workspace: string,
    paneId: string,
  ): Promise<{ path: string; expectedContent?: string } | null>;
  invoke<T = unknown>(request: OperationRequest): Promise<T>;
  onState(callback: (state: AppState) => void): void;
  browserLayout(rectangles: BrowserRectangle[]): void;
  browserOverviewBackdrop(
    ids: string[],
  ): Promise<{ id: string; url: string; bytes: Uint8Array }[]>;
  browserSelect(id: string): void;
  browserFind(
    id: string,
    text: string,
    options?: { forward?: boolean; findNext?: boolean },
  ): Promise<number>;
  browserStopFind(id: string): void;
  onBrowserFind(
    callback: (event: {
      browserId: string;
      requestId: number;
      matches: number;
      activeMatchOrdinal: number;
      finalUpdate: boolean;
    }) => void,
  ): void;
  browserFocus(id: string): void;
  onCommand(
    callback: (event: {
      command: import("./keyboard").CommandId;
      browserId?: string;
    }) => void,
  ): void;
  onTerminal(callback: (event: TerminalUiEvent) => void): void;
}
