import type { InspectionSection, ProviderInspection } from "./inspection.ts";
export type { InspectionSection, ProviderInspection } from "./inspection.ts";
export type ProviderId = "codex" | "kimi" | "claude";
export type ProviderState =
  "starting" | "ready" | "working" | "waiting" | "failed" | "closed";
export interface Conversation {
  provider: ProviderId;
  nativeId: string;
  cwd: string;
  /** Native session/model/mode metadata, without converting provider history. */
  metadata: unknown;
}
export interface PermissionOption {
  id: string;
  label: string;
  kind: string;
}
export interface TurnOutcome {
  status: "completed" | "cancelled";
  nativeReason: string;
}
export interface BackgroundActivity {
  id: string;
  kind: "agent" | "command";
  label: string;
  owner?: string;
  state: "running" | "completed" | "interrupted" | "failed" | "unknown";
  startedAt: number;
  finishedAt?: number;
  result?: string;
  exitCode?: number;
}

export type ProviderEvent = {
  provider: ProviderId;
  nativeId: string | null;
} & (
  | { type: "state"; state: ProviderState }
  | { type: "background"; activity: BackgroundActivity; removeId?: string }
  | { type: "turn-started"; nativeTurnId: string }
  | {
      type: "text";
      text: string;
      role: "assistant" | "user";
      replay: boolean;
      itemId?: string;
      clientId?: string;
      nativeTurnId?: string;
    }
  | {
      type: "tool";
      phase: "started" | "updated" | "completed";
      details: unknown;
      replay: boolean;
    }
  | {
      type: "permission";
      requestId: string;
      options: PermissionOption[];
      details: unknown;
    }
  | { type: "permission-resolved"; requestId: string }
  | {
      type: "message-meta";
      itemId: string;
      phase?: "commentary" | "partial" | "final";
      interactive?: boolean;
      questions?: import("../codex-questions").CodexQuestion[];
      text?: string;
    }
  | { type: "completed"; outcome: TurnOutcome }
  | { type: "history"; details: unknown }
  | { type: "error"; message: string }
  | { type: "diagnostic"; message: string }
);
export interface AdapterOptions {
  claudeEnvironment?: () => Promise<NodeJS.ProcessEnv>;
  cwd: string;
  executable?: string;
  /** Primarily for installations using a launcher, and subprocess contract tests. */
  args?: string[];
  /** Complete child environment; omitted means inherit without changing routing/auth. */
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  /** Deadline for a Kimi ACP session/prompt, which replies when its turn ends. */
  turnTimeoutMs?: number;
  /** Cod reserved this UUID locally, before Claude wrote native history. */
  unrecordedClaudeId?: string;
  onEvent?: (event: ProviderEvent) => void;
}
export interface NativeChoice {
  value: string;
  label: string;
}
export interface ProviderSelection {
  option: "model" | "reasoning";
  value: string;
}
export interface DraftOptionChange {
  option: ProviderSelection["option"];
  value?: string;
}
export interface ProviderOptions {
  models: NativeChoice[];
  reasoning: NativeChoice[];
  /** Native binding/config response values, never optimistic local selections. */
  current: { model?: string; reasoning?: string };
  /** Codex explicit overrides for future turns; not confirmed native active values. */
  pending?: { model?: string; reasoning?: string };
  selectionEffect: "next-turn" | "immediate";
}
export interface ProviderCapabilities {
  nativeResume: true;
  permissions: true;
  cancel: true;
  discovery: true;
  modelSelection: true;
  modeSelection: false;
  history: "native-snapshot" | "native-replay";
  caveats: readonly string[];
}
export interface ImageAttachment {
  reference?: number;
  name?: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
}
export interface ToolResult {
  name: string;
  namespace: string | null;
  output: string;
}
export interface SteeringInput {
  text: string;
  images?: ImageAttachment[];
  skills?: Array<{ name: string; path: string }>;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  readonly nativeId: string | null;
  readonly capabilities: ProviderCapabilities;
  subscribe(listener: (event: ProviderEvent) => void): () => void;
  create(): Promise<Conversation>;
  resume(nativeId: string): Promise<Conversation>;
  discover(): Promise<Conversation[]>;
  inspect(section: InspectionSection): Promise<ProviderInspection>;
  earlierHistory?(cursor: string): Promise<{
    items: unknown[];
    nextCursor?: string;
  }>;
  historyOutput?(turnId: string, itemId: string): Promise<unknown>;
  getOptions(): Promise<ProviderOptions>;
  getDraftOptions(
    selection: ProviderOptions["current"],
    change?: DraftOptionChange,
  ): Promise<ProviderOptions>;
  getSelection(): ProviderOptions["current"];
  setOption(selection: ProviderSelection): Promise<ProviderOptions>;
  /** Resolves after the native turn finishes, not merely after prompt acceptance. */
  resolveSkills(
    text: string,
    selected?: Array<{ name: string; path: string }>,
  ): Promise<Array<{ name: string; path: string }>>;
  send(
    text: string,
    images?: ImageAttachment[],
    skills?: Array<{ name: string; path: string }>,
    submission?: { id: string; accepted(): void },
  ): Promise<TurnOutcome>;
  activeTurnIdentity(): string | undefined;
  steer(
    input: SteeringInput,
    expectedTurnId: string,
    clientId: string,
  ): Promise<"accepted" | "uncertain" | "unsupported">;
  findSteeredItem(turnId: string, clientId: string): Promise<string | null>;
  sendToolResult(
    result: ToolResult,
    requireDispatchedTurn: boolean,
  ): Promise<string>;
  permission(requestId: string, optionId: string): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}
