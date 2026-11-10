import { icon } from "./controls";

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

/** Keep routine activity in one expandable row without hiding answers or decisions. */
export function groupTurnActivity(
  transcript: HTMLElement,
  conversation: import("../types").ConversationState,
): void {
  let key = "initial";
  const turns = new Map<string, HTMLElement[]>();
  for (const node of [...transcript.children] as HTMLElement[]) {
    if (node.classList.contains("user")) {
      key = node.dataset.turnId ?? node.dataset.messageId ?? key;
      if (!turns.has(key)) turns.set(key, []);
      continue;
    }
    const turnKey = node.dataset.turnId ?? key;
    const nodes = turns.get(turnKey) ?? [];
    nodes.push(node);
    turns.set(turnKey, nodes);
  }
  if (!turns.size && ["working", "waiting"].includes(conversation.status))
    turns.set("initial", []);
  const last = [...turns.keys()].at(-1);
  for (const [id, nodes] of turns) {
    const recorded = conversation.turns?.find((turn) => turn.id === id);
    const completed =
      !!recorded?.outcome ||
      (!recorded && (id !== last || conversation.status === "ready"));
    const live =
      !completed &&
      id === last &&
      ["working", "waiting"].includes(conversation.status);
    if (!completed && !live) continue;
    let lastTool = -1;
    nodes.forEach((node, index) => {
      if (node.classList.contains("tool-activity")) lastTool = index;
    });
    const activity = nodes.filter((node, index) => {
      if (node.hasAttribute("data-action-required")) return false;
      if (node.classList.contains("tool-activity")) return true;
      if (!node.classList.contains("assistant")) return false;
      if (node.dataset.phase === "commentary") return true;
      if (live && node.dataset.phase !== "final") return true;
      // Unknown imported history: preserve the complete final assistant block
      // after the last tool; never classify a sole answer by its wording.
      return !node.dataset.phase && lastTool >= 0 && index < lastTool;
    });
    const duration = recorded?.durationMs;
    const text = live
      ? conversation.status === "waiting"
        ? "Waiting for your response"
        : "Working"
      : duration !== undefined && Number.isFinite(duration)
        ? workedDuration(duration, recorded?.outcome)
        : "Activity";
    if (!activity.length && !live) {
      if (text !== "Activity" && nodes.length) {
        const header = document.createElement("div");
        header.className = "turn-activity";
        header.dataset.focusKey = `turn-duration:${id}`;
        header.textContent = text;
        transcript.insertBefore(header, nodes[0]);
      }
      continue;
    }
    const details = document.createElement("details");
    details.className = "turn-activity";
    details.dataset.focusKey = `turn-activity:${id}`;
    const summary = document.createElement("summary");
    summary.dataset.focusKey = `turn-summary:${id}`;
    if (!live) summary.setAttribute("aria-label", text);
    const label = document.createElement("span");
    label.textContent = text;
    if (live) {
      label.setAttribute("role", "status");
      label.setAttribute("aria-label", "Turn activity");
      if (conversation.status === "working" && recorded?.startedAt)
        label.dataset.activityStarted = recorded.startedAt;
    }
    summary.append(icon("chevron"), label);
    if (live && conversation.status === "working") {
      const current = [...activity]
        .reverse()
        .find(
          (node) =>
            node.classList.contains("tool-activity") &&
            node.dataset.toolPhase !== "completed",
        );
      if (current) {
        const action = document.createElement("span");
        action.className = "current-tool";
        action.textContent = current.dataset.compactCaption ?? "Using tool";
        summary.append(action);
      }
    }
    details.append(summary);
    transcript.insertBefore(details, nodes[0] ?? null);
    details.append(...activity);
    updateLiveActivity(details);
  }
}

export function toolCaption(info: Record<string, unknown> | null): string {
  if (!info) return "Tool";
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
    "[data-activity-started]",
  )) {
    const start = Date.parse(label.dataset.activityStarted!);
    if (!Number.isFinite(start)) continue;
    const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const elapsed =
      seconds < 60
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    label.textContent = `Working · ${elapsed}`;
  }
}

export function compactToolCaption(
  info: Record<string, unknown> | null,
): string {
  if (typeof info?.command === "string") return "Running command";
  if (Array.isArray(info?.changes)) return "Editing files";
  if (typeof info?.query === "string") return "Searching";
  const name = String(info?.name ?? info?.toolName ?? info?.type ?? "");
  return (
    name
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .slice(0, 80) || "Using tool"
  );
}
