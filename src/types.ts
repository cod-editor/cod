import type { SiteIcons } from "./browser/site-icon-types";
import type {
  BackgroundActivity,
  PermissionOption,
  ProviderId,
  ProviderState,
} from "./providers/types";

export interface DocumentPane {
  id: string;
  kind: "document";
  draftChat?: boolean;
  filePath?: string;
  canonicalPath?: string;
  line?: number;
  lineRequestId?: string;
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
  certificateOffer?: string;
  temporaryCertificate?: boolean;
  temporaryNavigationBlocked?: boolean;
  httpFallback?: { id: string; url: string };
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
  favicon?: string;
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
export interface BrowserLayout {
  rectangles: BrowserRectangle[];
  popup?: import("./browser/address-suggestion-types").AddressSuggestionPopup;
  downloads?: import("./browser/download-presentation").DownloadPopup;
  resumeModal?: number;
}

export type BrowserModalCover = { kind: "shell-modal"; opening: number };

export type ShellMenuItem = {
  label: string;
  shortcut: string;
  disabled: boolean;
  selected?: boolean;
  title?: string;
} | null;
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
  questions?: import("./codex-questions").CodexQuestion[];
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
  steering?: {
    nativeTurnId: string;
    localTurnId: string;
    draftVersion?: string;
  };
}

export interface ConversationState {
  /** Effective Claude mode projected into the desktop snapshot only. */
  claudePermissionMode?: import("./providers/types").ClaudePermissionMode;
  initialSelection?: import("./providers/types").ProviderOptions["current"];
  claudeSelection?: import("./providers/types").ProviderOptions["current"];
  queuedMessages?: QueuedMessage[];
  reservedQuestionAnswers?: string[];
  queuePaused?: boolean;
  claudeSubmission?: { messageId: string; draftVersion?: string };
  displayName?: string;
  handoffTerminalId?: string;
  taskStatus?: "working" | "waiting" | "review" | "ready" | "failed";
  taskStatusContext?: string;
  taskStatusUpdatedAt?: string;
  taskStatusAcknowledgedAt?: string;
  completionRevision?: number;
  acknowledgedCompletionRevision?: number;
  id: string;
  detachedOwner?: import("./providers/local-owner-protocol").LocalOwnerCursor;
  transfer?: {
    id: string;
    host: string;
    workspace: string;
    cwd: string;
    committing?: boolean;
  };
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

export interface TerminalProcessState {
  id: string;
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

export interface TerminalState extends TerminalProcessState {
  nativeConversationId?: string;
  paneId: string;
}

export type QuickTerminalSummary = Pick<
  TerminalProcessState,
  "id" | "workspaceId" | "status"
>;

export interface TerminalUiEvent {
  terminalId: string;
  sequence: number;
  type: "data" | "exit" | "error";
  data?: string;
  message?: string;
}

export interface GroupLeaf {
  type: "leaf";
  paneId: string;
}
export type GroupLayout =
  | GroupLeaf
  | {
      type: "split";
      direction: "right";
      ratio: number;
      first: GroupLeaf;
      second: GroupLeaf;
    };

export interface TabGroup {
  id: string;
  paneIds: string[];
  activePaneId: string;
  hidden?: boolean;
}
export interface WorkspaceSettings {
  filesVisible?: boolean;
  chatMaxWidth?: number;
  filesWidth?: number;
}
export interface WorkspaceState {
  untitledSequence?: number;
  closedTabs?: Array<{
    pane: PaneState;
    groupId?: string;
    index?: number;
    collapsedSplit?: true;
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
  groups: TabGroup[];
  groupLayout: GroupLayout;
  activeGroupId: string;
  settings?: WorkspaceSettings;
  id: string;
  name: string;
  folders: string[];
  panes: PaneState[];
  activePaneId: string;
}

export interface AppState {
  browserDownloads?: import("./browser/download-types").BrowserDownload[];
  sitePermissions?: import("./browser/permission-types").SitePolicy[];
  pinnedSites?: Array<{ url: string; title: string } & SiteIcons>;
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
  /** Live pane-free shells. Never written to workspace data. */
  quickTerminals?: QuickTerminalSummary[];
  browsers: BrowserState[];
  drafts: Record<string, FileDraft>;
  reviews?: ReviewSummary[];
  transferredCodexSessions?: string[];
  pendingCodexImports?: Record<
    string,
    { id: string; digest: string; workspace: string; cwd: string }
  >;
  completedCodexImports?: Record<
    string,
    {
      id: string;
      paneId: string;
      nativeId: string;
      linkedRollout?: { cwd: string; path: string };
    }
  >;
  /** Desktop connection status. Never written to workspace data. */
  remoteWorkspace?: import("./remote-workspace/protocol").RemoteWorkspaceView;
  /** Renderer-only navigation intent. Never written to application data. */
  reviewPresentation?: { paneId: string; token: string };
}

export interface OperationRequest {
  op: string;
  [key: string]: unknown;
}

export interface CodBridge {
  onReleaseUpdate(
    callback: (
      notice: import("./release-update").ReleaseUpdateNotice | null,
    ) => void,
  ): void;
  openReleaseUpdate(): Promise<void>;
  toggleDevTools(browserId?: string): Promise<void>;
  onSettings(
    callback: (state: import("./settings").SettingsState) => void,
  ): void;
  openSettings(): Promise<void>;
  claudeApiSettings(
    request: import("./application/claude-api-settings").ClaudeApiRequest,
  ): Promise<import("./application/claude-api-settings").ClaudeApiStatus>;
  setClaudePermissionMode(
    id: string,
    mode: import("./providers/types").ClaudePermissionChoice,
  ): Promise<void>;
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
  browserLayout(layout: BrowserLayout): void;
  onBrowserSuggestionPick(
    callback: (id: string, revision: number, index: number) => void,
  ): void;
  onBrowserSuggestionDismiss(
    callback: (id: string, revision: number) => void,
  ): void;
  onBrowserDownloadDismiss(
    callback: (revision: number, restore: boolean) => void,
  ): void;
  shellMenu(
    anchor: { x: number; y: number },
    items: ShellMenuItem[],
  ): Promise<number | null>;
  browserCoverModal(cover: BrowserModalCover): Promise<boolean>;
  browserPrepareModal(
    ids: string[],
    opening: number,
  ): Promise<{ id: string; url: string; bytes: Uint8Array }[]>;
  browserSelect(id: string): void;
  browserFind(
    id: string,
    text: string,
    options?: { forward?: boolean; findNext?: boolean },
  ): Promise<number>;
  browserStopFind(id: string): void;
  browserFindVisibility(id: string, visible: boolean): void;
  onBrowserFindDismiss(callback: (id: string) => void): void;
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
