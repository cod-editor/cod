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

/** Fold completed routine activity without hiding final answers or decisions. */
export function groupTurnActivity(
  transcript: HTMLElement,
  conversation: import("../types").ConversationState,
): void {
  let key = "initial";
  const turns = new Map<string, HTMLElement[]>();
  for (const node of [...transcript.children] as HTMLElement[]) {
    if (node.classList.contains("user")) {
      key = node.dataset.turnId ?? node.dataset.messageId ?? key;
      continue;
    }
    const turnKey = node.dataset.turnId ?? key;
    const nodes = turns.get(turnKey) ?? [];
    nodes.push(node);
    turns.set(turnKey, nodes);
  }
  const last = [...turns.keys()].at(-1);
  for (const [id, nodes] of turns) {
    const recorded = conversation.turns?.find((turn) => turn.id === id);
    const completed =
      !!recorded?.outcome ||
      (!recorded && (id !== last || conversation.status === "ready"));
    if (!completed) continue;
    let lastTool = -1;
    nodes.forEach((node, index) => {
      if (node.classList.contains("tool-activity")) lastTool = index;
    });
    const activity = nodes.filter((node, index) => {
      if (node.hasAttribute("data-action-required")) return false;
      if (node.classList.contains("tool-activity")) return true;
      if (!node.classList.contains("assistant")) return false;
      if (node.dataset.phase === "commentary") return true;
      // Unknown imported history: preserve the complete final assistant block
      // after the last tool; never classify a sole answer by its wording.
      return !node.dataset.phase && lastTool >= 0 && index < lastTool;
    });
    const duration = recorded?.durationMs;
    const text =
      duration !== undefined && Number.isFinite(duration)
        ? workedDuration(duration, recorded?.outcome)
        : "Activity";
    if (!activity.length) {
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
    summary.setAttribute("aria-label", text);
    const label = document.createElement("span");
    label.textContent = text;
    summary.append(icon("chevron"), label);
    details.append(summary);
    transcript.insertBefore(details, activity[0]);
    details.append(...activity);
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
