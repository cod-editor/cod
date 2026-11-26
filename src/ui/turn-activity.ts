import { icon } from "../ui-kit";

function workedDuration(ms: number, outcome?: string): string {
  const prefix =
    outcome === "cancelled"
      ? "Stopped after"
      : outcome === "failed"
        ? "Failed after"
        : "Worked for";
  if (ms < 1000) return `${prefix} <1s`;
  const seconds = Math.floor(ms / 1000);
  return seconds < 60
    ? `${prefix} ${seconds}s`
    : `${prefix} ${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
}

type Conversation = import("../types").ConversationState;
type RecordedTurn = NonNullable<Conversation["turns"]>[number];

interface TurnSection {
  key: string;
  user?: HTMLElement;
  nodes: HTMLElement[];
}

function turnSections(transcript: HTMLElement) {
  const rows = [...transcript.children] as HTMLElement[];
  const turns = new Map<string, TurnSection[]>();
  let fallback = "initial";
  let current: { id: string; section: TurnSection } | undefined;
  for (const node of rows) {
    const user = node.classList.contains("user");
    if (user)
      fallback = node.dataset.turnId ?? node.dataset.messageId ?? fallback;
    if (!node.matches(".chat-message, .tool-activity")) continue;
    const id = node.dataset.turnId ?? fallback;
    if (user || current?.id !== id) {
      const sections = turns.get(id) ?? [];
      const section: TurnSection = {
        key: sections.length
          ? `${id}:${node.dataset.messageId ?? node.dataset.toolId}`
          : id,
        user: user ? node : undefined,
        nodes: [],
      };
      sections.push(section);
      turns.set(id, sections);
      current = { id, section };
    }
    if (!user) current!.section.nodes.push(node);
  }
  return turns;
}

function hasAssistantText(node: HTMLElement): boolean {
  return node.classList.contains("assistant") && !!node.textContent?.trim();
}

/** Fold activity in consecutive runs so no collapsed block crosses a visible message. */
function orderedRuns(nodes: HTMLElement[]): HTMLElement[][] {
  const runs: HTMLElement[][] = [];
  let current: HTMLElement[] | undefined;
  for (const node of nodes) {
    if (
      !node.classList.contains("tool-activity") ||
      node.hasAttribute("data-action-required")
    ) {
      current = undefined;
      continue;
    }
    if (!current) {
      current = [];
      runs.push(current);
    }
    current.push(node);
  }
  return runs;
}

function activityProgress(
  transcript: HTMLElement,
  before: Node | null,
  conversation: Conversation,
  recorded: RecordedTurn | undefined,
  key: string,
): void {
  const progress = document.createElement("div");
  progress.className = "turn-progress";
  progress.dataset.focusKey = `turn-progress:${key}`;
  const label = document.createElement("span");
  label.textContent =
    conversation.status === "waiting" ? "Waiting for your response" : "Working";
  label.setAttribute("role", "status");
  label.setAttribute("aria-label", "Turn activity");
  if (conversation.status === "working" && recorded?.startedAt)
    label.dataset.activityStarted = recorded.startedAt;
  progress.append(label);
  transcript.insertBefore(progress, before);
  updateLiveActivity(progress);
}

function activityDetails(
  transcript: HTMLElement,
  before: Node | null,
  activity: HTMLElement[],
  key: string,
  text: string,
  live: boolean,
): void {
  const details = document.createElement("details");
  details.className = "turn-activity";
  details.dataset.focusKey = `turn-activity:${key}`;
  const summary = document.createElement("summary");
  summary.dataset.focusKey = `turn-summary:${key}`;
  const label = document.createElement("span");
  if (live) {
    label.className = "current-tool";
    label.textContent = activity.reduce(
      (caption, tool) =>
        tool.dataset.collaborationActivity
          ? caption
          : (tool.dataset.compactCaption ?? caption),
      text,
    );
    summary.append(label, icon("chevron"));
    details.classList.add("live-activity");
  } else {
    summary.setAttribute("aria-label", text);
    label.textContent = text;
    summary.append(icon("chevron"), label);
  }
  details.append(summary);
  transcript.insertBefore(details, before);
  details.append(...activity);
}

/** Keep routine activity expandable and keep the native turn chronology around new input. */
export function groupTurnActivity(
  transcript: HTMLElement,
  conversation: Conversation,
): void {
  const running = ["working", "waiting"].includes(conversation.status);
  const turns = turnSections(transcript);
  if (!turns.size && running)
    turns.set("initial", [{ key: "initial", nodes: [] }]);
  const last = [...turns.keys()].at(-1);
  const recordedTurns = new Map(
    conversation.turns?.map((turn) => [turn.id, turn]),
  );
  for (const [id, sections] of turns) {
    const recorded = recordedTurns.get(id);
    const completed =
      !!recorded?.outcome ||
      (!recorded && (id !== last || conversation.status === "ready"));
    const live = !completed && id === last && running;
    if (!completed && !live) continue;
    const lastSection = sections.at(-1)!;
    if (
      recorded?.outcome === "completed" &&
      !sections.some(({ nodes }) => nodes.some(hasAssistantText))
    ) {
      const warning = document.createElement("div");
      warning.className = "turn-reply-missing";
      warning.textContent = "Agent finished without a text reply.";
      const preceding = lastSection.nodes.at(-1) ?? lastSection.user;
      transcript.insertBefore(warning, preceding?.nextSibling ?? null);
    }
    for (const section of sections) {
      const { nodes } = section;
      const sectionLive = live && section === lastSection;
      const duration = recorded?.durationMs;
      const caption =
        completed &&
        section === lastSection &&
        duration !== undefined &&
        Number.isFinite(duration)
          ? workedDuration(duration, recorded?.outcome)
          : "Activity";
      const runs = orderedRuns(nodes);
      const trailing = runs.at(-1);
      const liveRun =
        sectionLive && trailing?.at(-1) === nodes.at(-1) ? trailing : undefined;
      runs.forEach((run, index) => {
        const key =
          index === 0 ? section.key : `${section.key}:${run[0].dataset.toolId}`;
        if (run === liveRun)
          activityProgress(
            transcript,
            run[0],
            conversation,
            recorded,
            section.key,
          );
        activityDetails(
          transcript,
          run[0],
          run,
          key,
          run === trailing ? caption : "Activity",
          run === liveRun,
        );
      });
      if (sectionLive && !liveRun) {
        const preceding = nodes.at(-1) ?? section.user;
        activityProgress(
          transcript,
          preceding?.nextSibling ?? null,
          conversation,
          recorded,
          section.key,
        );
      }
      if (runs.length) continue;
      if (caption !== "Activity" && nodes.length) {
        const header = document.createElement("div");
        header.className = "turn-activity";
        header.dataset.focusKey = `turn-duration:${section.key}`;
        header.textContent = caption;
        transcript.insertBefore(header, nodes[0]);
      }
    }
  }
}

export function toolCaption(info: Record<string, unknown> | null): string {
  if (!info) return "Tool";
  if (info.type === "functionCallOutput")
    return `Tool result · ${[info.namespace, info.name].filter(Boolean).join(".")}`;
  for (const key of ["title", "command", "name", "toolName", "tool"]) {
    if (typeof info[key] === "string" && info[key]) return String(info[key]);
  }
  if (Array.isArray(info.changes)) {
    const paths = info.changes
      .map((change) =>
        typeof change === "object" && change !== null
          ? String((change as Record<string, unknown>).path ?? "")
          : "",
      )
      .filter(Boolean);
    if (paths.length)
      return `Edit ${paths.map((path) => path.split("/").pop()).join(", ")}`;
  }
  if (typeof info.query === "string") return `Search: ${info.query}`;
  if (typeof info.type === "string")
    return info.type
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .replace(/^./, (value) => value.toUpperCase());
  return "Tool";
}

// Update only the clock text, without rebuilding the transcript or moving focus.
export function updateLiveActivity(root: ParentNode = document): void {
  for (const label of root.querySelectorAll<HTMLElement>(
    "[data-activity-started], .composer-background[open] [data-background-started]",
  )) {
    const background = label.dataset.backgroundStarted;
    const start = background
      ? Number(background)
      : Date.parse(label.dataset.activityStarted!);
    if (!Number.isFinite(start)) continue;
    const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const elapsed =
      seconds < 60
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    label.textContent = background ? ` · ${elapsed}` : `Working · ${elapsed}`;
  }
}

export function compactToolCaption(
  info: Record<string, unknown> | null,
): string {
  if (info?.type === "functionCallOutput")
    return toolCaption(info).slice(0, 100);
  if (info?.type === "collabAgentToolCall" && typeof info.tool === "string")
    return toolCaption(info).slice(0, 100);
  if (typeof info?.title === "string" && info.title.trim())
    return info.title.trim().slice(0, 100);
  if (Array.isArray(info?.commandActions)) {
    const action = info.commandActions[0] as
      Record<string, unknown> | undefined;
    if (action?.type === "read")
      return `Read ${String(action.name ?? "file")
        .split("/")
        .pop()}`;
    if (action?.type === "listFiles") return "List files";
    if (action?.type === "search") return "Search files";
  }
  if (typeof info?.command === "string") {
    // Identify the executable only; command arguments and output stay in details.
    const command = info.command
      .trim()
      .replace(/^(?:\S*\/)?(?:ba|z|fi|da)?sh\s+-[a-z]*c\s+['"]?/, "");
    const executable = command.match(/^(?:[\w./-]+\/)?([\w.+-]+)/)?.[1];
    return executable ? `Run ${executable}` : "Run command";
  }
  if (Array.isArray(info?.changes)) return "Edit files";
  if (typeof info?.query === "string") return "Search";
  const name = String(info?.name ?? info?.toolName ?? info?.type ?? "");
  return (
    name
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .slice(0, 80) || "Use tool"
  );
}
