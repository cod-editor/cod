import { defaultSearchEngine } from "./browser/address";
import { SettingsService } from "./application/settings-service";
import { IntegrationApplicationService } from "./application/integration-service";
import { WorkspaceApplicationService } from "./application/workspace-service";
import { ReviewApplicationService } from "./application/review-service";
import { ConversationApplicationService } from "./application/conversation-service";
import { ConversationTransferService } from "./application/conversation-transfer";
import type {
  BrowserApplicationService,
  BrowserConversationPort,
} from "./application/browser-service";
import { FileApplicationService } from "./application/file-service";
import { TerminalApplicationService } from "./application/terminal-service";
import { ApplicationStateStore } from "./application/state";
import type { BrowserWindow, Session } from "electron";
import { desktopWorkspaceOperations, operations } from "./command-catalog";
import type { BuildInfo } from "./build-info";
import { LocalProviderOwner } from "./providers/local-owner-client";
import type {
  AppState,
  BrowserRectangle,
  OperationRequest,
  TerminalUiEvent,
} from "./types";

export class ApplicationOperations {
  readonly settings: SettingsService;
  readonly transfers: ConversationTransferService;
  private readonly integration = new IntegrationApplicationService();
  private readonly files: FileApplicationService;
  private readonly browserHost?: BrowserApplicationService;
  private readonly conversations: ConversationApplicationService;
  private readonly workspaces: WorkspaceApplicationService;
  private readonly store: ApplicationStateStore;
  private readonly reviews: ReviewApplicationService;
  private readonly terminals: TerminalApplicationService;
  onDidChange: ((state: AppState) => void) | undefined;
  onDidTerminal: ((event: TerminalUiEvent) => void) | undefined;

  constructor(
    dataDirectory: string,
    private readonly runtimeBuild: Readonly<BuildInfo> | null = null,
    createBrowserHost?: (
      store: ApplicationStateStore,
      conversations: BrowserConversationPort,
    ) => BrowserApplicationService,
  ) {
    this.settings = new SettingsService(dataDirectory);
    this.store = new ApplicationStateStore(dataDirectory);
    this.files = new FileApplicationService(this.store, (request) =>
      this.browsers.openBrowser(request),
    );
    this.browserHost = createBrowserHost?.(this.store, {
      isActive: (id) => this.conversations.isActive(id),
      send: (request) => this.conversations.sendConversation(request),
    });
    this.store.onDidChange = (state) => this.onDidChange?.(state);
    this.store.beforeNotify = () => this.browserHost?.synchronizeNativeViews();
    this.terminals = new TerminalApplicationService(this.store);
    this.terminals.onDidTerminal = (event) => this.onDidTerminal?.(event);
    this.conversations = new ConversationApplicationService(
      this.store,
      this.terminals,
      {
        show: (id) => this.workspaces.handle({ op: "conversation.show", id }),
        finishPage: (request, id, status) =>
          this.browserHost?.finishPage(request, id, status),
      },
      this.browserHost &&
        (process.platform === "darwin" || process.platform === "linux")
        ? {
            owner: new LocalProviderOwner(
              dataDirectory,
              runtimeBuild?.sourceHash.slice(0, 24),
            ),
            enabled: () => this.settings.state.values["chat.detachedSessions"],
          }
        : undefined,
    );
    this.reviews = new ReviewApplicationService(this.store, this.conversations);
    this.workspaces = new WorkspaceApplicationService(
      this.store,
      this.conversations,
      this.browserHost,
      this.terminals,
      this.reviews,
    );
    this.transfers = new ConversationTransferService(
      this.store,
      this.conversations,
      this.workspaces,
    );
  }

  private get browsers(): BrowserApplicationService {
    if (!this.browserHost)
      throw new Error("Browser operations require the desktop client");
    return this.browserHost;
  }

  attachAgentPageHost(window: BrowserWindow, session: Session): void {
    this.browsers.attachAgentPageHost(window, session);
  }
  fileSaveDefault(workspace: string, paneId: string): string {
    return this.files.saveDefault(workspace, paneId);
  }
  fileSaveChoice(
    path: string,
  ): Promise<{ path: string; expectedContent?: string }> {
    return this.files.saveChoice(path);
  }
  attachBrowserHost(
    window: BrowserWindow,
    session: Session,
    downloadDirectory: string,
  ): void {
    this.browsers.attachBrowserHost(window, session, downloadDirectory);
  }
  browserLayout(rectangles: BrowserRectangle[], retireOverview = false): void {
    this.browsers.browserLayout(rectangles, retireOverview);
  }
  browserHideForOverview(opening: number): boolean {
    return this.browsers.browserHideForOverview(opening);
  }
  browserOverviewBackdrop(ids: unknown, opening?: number) {
    return this.browsers.browserOverviewBackdrop(ids, opening);
  }
  browserFind(
    id: string,
    text: string,
    options: { forward?: boolean; findNext?: boolean } = {},
  ): Promise<number> {
    return this.browsers.browserFind(id, text, options);
  }
  browserFindVisibility(id: string, visible: boolean): void {
    this.browsers.browserFindVisibility(id, visible);
  }
  browserStopFind(id: string): void {
    this.browsers.browserStopFind(id);
  }
  browserDevTools(id: string): void {
    this.browsers.browserDevTools(id);
  }
  browserFocus(id: string): void {
    this.browsers.browserFocus(id);
  }
  browserSelect(id: string): void {
    this.browsers.browserSelect(id);
  }
  browserPermissionDenied(contentsId: number, permission: string): void {
    this.browsers.browserPermissionDenied(contentsId, permission);
  }

  async initialize(): Promise<void> {
    await this.settings.load();
    await this.store.load();
    if (
      !this.store.data.workspaces.length &&
      !this.store.data.closedWorkspaces?.length
    )
      await this.store.change(() =>
        this.workspaces.createWorkspace("Untitled"),
      );
    await this.conversations.restoreInterrupted();
    await this.files.restoreIdentity();
    this.browserHost?.restoreSubmissions();
    this.terminals.restoreAll();
    await this.reviews.reconcileOrigins();
    await this.reviews.refreshReviews();
  }

  diagnosticContext(contentsId: number) {
    return this.browsers.diagnosticContext(contentsId);
  }

  get activeWorkspaceId(): string | null {
    return this.store.data.activeWorkspaceId;
  }
  snapshot(forUi = false): AppState {
    return this.store.snapshot(forUi);
  }

  private async newContextualTab(request: OperationRequest): Promise<unknown> {
    const source = await this.store.serialize(() => {
      const workspace = this.store.workspace(String(request.workspace));
      const pane = this.store.openingPane(workspace, {
        ...request,
        sourcePane: request.sameAs,
      });
      const group = workspace.groups!.find((item) =>
        item.paneIds.includes(pane.id),
      )!;
      const conversation =
        pane.kind === "conversation"
          ? this.store.conversation(pane.conversationId)
          : undefined;
      const draft =
        pane.kind === "document" && !pane.filePath
          ? workspace.chatDrafts?.[pane.id]
          : undefined;
      return {
        pane: { ...pane },
        group: group.id,
        provider: conversation?.provider ?? draft?.provider ?? "codex",
        selection: conversation
          ? this.conversations.selection(conversation.id)
          : draft?.initialSelection,
        cwd: conversation?.cwd ?? draft?.cwd,
      };
    });
    const target = {
      workspace: request.workspace,
      group: source.group,
      sourcePane: source.pane.id,
      focus: request.focus ?? false,
    };
    if (source.pane.kind === "browser")
      return this.browsers.handle({
        op: "browser.open",
        ...target,
        url: "about:blank",
      });
    if (source.pane.kind === "terminal") {
      const cwd = await this.terminals.currentDirectory(source.pane.terminalId);
      return this.terminals.handle({ op: "terminal.open", ...target, cwd });
    }
    if (
      source.pane.kind === "conversation" ||
      (source.pane.kind === "document" && !source.pane.filePath)
    )
      return this.workspaces.handle({
        op: "conversation.draft",
        ...target,
        provider: source.provider,
        initialSelection: source.selection,
        cwd: source.cwd,
      });
    if (
      source.pane.kind === "document" ||
      source.pane.kind === "untitled" ||
      source.pane.kind === "preview"
    )
      return this.files.handle({ op: "file.new", ...target });
    return this.workspaces.handle({ op: "pane.new", ...target });
  }

  async dispatch(
    request: OperationRequest,
    trustedUi = false,
  ): Promise<unknown> {
    if (
      !request ||
      typeof request !== "object" ||
      typeof request.op !== "string"
    ) {
      throw new Error("An operation object with an op string is required");
    }
    const location = this.browserHost ? "local" : "linux";
    if (request.op === "conversation.accept-transfer") {
      if (!trustedUi || this.browserHost)
        throw new Error("Pair the desktop to move a conversation to Linux");
      return this.transfers.accept(request);
    }
    if (request.op === "workspace.prepare" && request.location !== location)
      throw new Error("This workspace preparation targets a different host");
    if (request.op.startsWith("review."))
      return this.reviews.handle(request, trustedUi);
    if (request.op === "pane.new" && request.sameAs !== undefined) {
      if (request.sourcePane !== undefined)
        throw new Error("Choose sameAs or sourcePane, not both");
      if (typeof request.sameAs !== "string" || !request.sameAs)
        throw new Error("sameAs must be a source tab ID");
      return this.newContextualTab(request);
    }
    if (request.op === "settings.get") return this.settings.state;
    if (request.op === "settings.update") {
      const result = await this.settings.update(
        request.values,
        request.reset === true,
      );
      if (request.reset === true && this.browserHost) {
        try {
          await this.browsers.handle({
            op: "browser.settings",
            searchEngine: defaultSearchEngine,
          });
        } catch (error) {
          throw new Error(
            `Appearance settings were reset, but browser settings could not be reset: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return result;
    }
    if (request.op === "browser.close" || request.op === "terminal.close") {
      const resource =
        request.op === "browser.close"
          ? this.browsers.browser(String(request.id))
          : this.terminals.terminal(String(request.id));
      const result = (await this.workspaces.handle(
        {
          op: "pane.close",
          workspace: resource.workspaceId,
          id: resource.paneId,
          includePinned: request.includePinned,
        },
        trustedUi,
      )) as { closed?: boolean };
      return { id: resource.id, closed: result.closed !== false };
    }
    const domain = request.op.split(".")[0];
    if (
      domain === "workspace" ||
      domain === "pane" ||
      domain === "group" ||
      request.op === "conversation.draft" ||
      request.op === "conversation.show" ||
      request.op === "conversation.move" ||
      request.op === "conversation.remove"
    )
      return this.workspaces.handle(request, trustedUi);
    if (domain === "conversation")
      return this.conversations.handle(request, trustedUi);
    if (["file", "project", "git", "preview", "diff"].includes(domain!))
      return this.files.handle(request, trustedUi);
    if (domain === "browser" || domain === "page")
      return this.browsers.handle(request, trustedUi);
    if (domain === "terminal") return this.terminals.handle(request, trustedUi);
    if (domain === "agent-integration")
      return this.integration.handle(request, trustedUi);
    switch (request.op) {
      case "capabilities":
        return {
          runtime: { build: this.runtimeBuild },
          operations: this.browserHost
            ? operations
            : operations.filter(
                (op) =>
                  !op.startsWith("browser.") &&
                  !op.startsWith("page.") &&
                  !desktopWorkspaceOperations.has(op),
              ),
          providers: {
            codex: {
              available: true,
              nativeResume: true,
              permissions: true,
              cancel: true,
              images: true,
              modelSelection: true,
              toolResults: true,
            },
            kimi: {
              available: true,
              nativeResume: true,
              permissions: true,
              cancel: true,
              images: true,
              modelSelection: true,
              toolResults: false,
            },
            claude: {
              available: false,
              reason: "Native adapter is not implemented",
            },
          },
        };

      case "context": {
        const conversation = this.store.data.conversations.find(
          (item) => item.id === request.conversation,
        );
        if (!conversation) throw new Error("Unknown conversation");
        const workspace = this.store.workspace(conversation.workspaceId);
        return {
          location,
          workspace: {
            id: workspace.id,
            name: workspace.name,
            folders: [...workspace.folders],
            activePaneId: workspace.activePaneId,
          },
          conversation: {
            id: conversation.id,
            provider: conversation.provider,
            nativeId: conversation.nativeId,
            cwd: conversation.cwd,
            status: conversation.status,
          },
        };
      }
      case "state":
        return this.snapshot(trustedUi);

      default:
        throw new Error(`Unknown operation: ${request.op}`);
    }
  }

  quitStatus() {
    return this.conversations.quitStatus();
  }

  async shutdown(leaveRunning = false): Promise<void> {
    this.store.beginShutdown();
    await this.conversations.shutdown(leaveRunning);
    await this.reviews.shutdown();
    await this.browserHost?.shutdown();
    await this.terminals.shutdown();
    await this.store.serialize(() => this.store.persist());
  }
}
