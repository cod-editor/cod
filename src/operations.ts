import { IntegrationApplicationService } from "./application/integration-service";
import { WorkspaceApplicationService } from "./application/workspace-service";
import { ReviewApplicationService } from "./application/review-service";
import { ConversationApplicationService } from "./application/conversation-service";
import { BrowserApplicationService } from "./application/browser-service";
import { FileApplicationService } from "./application/file-service";
import { TerminalApplicationService } from "./application/terminal-service";
import { ApplicationStateStore } from "./application/state";
import type { BrowserWindow, Session } from "electron";
import { operations } from "./command-catalog";
import type {
  AppState,
  BrowserRectangle,
  OperationRequest,
  TerminalUiEvent,
} from "./types";

export class ApplicationOperations {
  private readonly integration = new IntegrationApplicationService();
  private readonly files: FileApplicationService;
  private readonly browsers: BrowserApplicationService;
  private readonly conversations: ConversationApplicationService;
  private readonly workspaces: WorkspaceApplicationService;
  private readonly store: ApplicationStateStore;
  private readonly reviews: ReviewApplicationService;
  private readonly terminals: TerminalApplicationService;
  onDidChange: ((state: AppState) => void) | undefined;
  onDidTerminal: ((event: TerminalUiEvent) => void) | undefined;

  constructor(dataDirectory: string) {
    this.store = new ApplicationStateStore(dataDirectory);
    this.files = new FileApplicationService(this.store);
    this.browsers = new BrowserApplicationService(this.store, {
      isActive: (id) => this.conversations.isActive(id),
      send: (request) => this.conversations.sendConversation(request),
    });
    this.store.onDidChange = (state) => this.onDidChange?.(state);
    this.store.beforeNotify = () => this.browsers.synchronizeNativeViews();
    this.terminals = new TerminalApplicationService(this.store);
    this.terminals.onDidTerminal = (event) => this.onDidTerminal?.(event);
    this.conversations = new ConversationApplicationService(
      this.store,
      this.terminals,
      {
        show: (id) => this.workspaces.handle({ op: "conversation.show", id }),
        finishPage: (request, id, status) =>
          this.browsers.finishPage(request, id, status),
      },
    );
    this.reviews = new ReviewApplicationService(this.store, this.conversations);
    this.workspaces = new WorkspaceApplicationService(
      this.store,
      this.conversations,
      this.browsers,
      this.terminals,
      this.reviews,
    );
  }

  attachAgentPageHost(window: BrowserWindow, session: Session): void {
    this.browsers.attachAgentPageHost(window, session);
  }
  attachBrowserHost(
    window: BrowserWindow,
    session: Session,
    downloadDirectory: string,
  ): void {
    this.browsers.attachBrowserHost(window, session, downloadDirectory);
  }
  browserLayout(rectangles: BrowserRectangle[]): void {
    this.browsers.browserLayout(rectangles);
  }
  browserFind(
    id: string,
    text: string,
    options: { forward?: boolean; findNext?: boolean } = {},
  ): Promise<number> {
    return this.browsers.browserFind(id, text, options);
  }
  browserStopFind(id: string): void {
    this.browsers.browserStopFind(id);
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
    await this.store.load();
    this.conversations.restoreInterrupted();
    await this.files.restoreIdentity();
    this.browsers.restoreSubmissions();
    this.terminals.restoreAll();
    await this.reviews.reconcileOrigins();
    await this.reviews.refreshReviews();
  }

  snapshot(): AppState {
    return this.store.snapshot();
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
    if (request.op.startsWith("review."))
      return this.reviews.handle(request, trustedUi);
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
          operations,
          providers: {
            codex: {
              available: true,
              nativeResume: true,
              permissions: true,
              cancel: true,
              images: true,
              modelSelection: true,
            },
            kimi: {
              available: true,
              nativeResume: true,
              permissions: true,
              cancel: true,
              images: true,
              modelSelection: true,
            },
            claude: {
              available: false,
              reason: "Native adapter is not implemented",
            },
          },
        };

      case "state":
        return this.snapshot();

      default:
        throw new Error(`Unknown operation: ${request.op}`);
    }
  }

  async shutdown(): Promise<void> {
    this.store.beginShutdown();
    await this.conversations.shutdown();
    await this.reviews.shutdown();
    this.browsers.shutdown();
    await this.terminals.shutdown();
    await this.store.serialize(() => this.store.persist());
  }
}
