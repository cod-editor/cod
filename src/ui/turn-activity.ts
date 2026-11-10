import { icon } from "./controls";

/** Aggregate routine steps per user/assistant turn, leaving all messages visible. */
export function groupTurnActivity(
  transcript: HTMLElement,
  provider: string,
): void {
  let key = "initial";
  const turns = new Map<
    string,
    { first: HTMLElement; messages: HTMLElement[]; tools: HTMLElement[] }
  >();
  for (const node of [...transcript.children] as HTMLElement[]) {
    if (node.classList.contains("user")) {
      key = node.dataset.messageId ?? key;
      continue;
    }
    const message = node.classList.contains("assistant");
    const tool =
      node.classList.contains("tool-activity") &&
      !node.hasAttribute("data-action-required");
    if (!message && !tool) continue;
    let turn = turns.get(key);
    if (!turn) {
      turn = { first: node, messages: [], tools: [] };
      turns.set(key, turn);
    }
    if (message) turn.messages.push(node);
    if (tool) turn.tools.push(node);
  }
  for (const [id, turn] of turns) {
    if (!turn.tools.length) continue;
    const details = document.createElement("details");
    details.className = "turn-activity";
    details.dataset.focusKey = `turn-activity:${id}`;
    const summary = document.createElement("summary");
    summary.dataset.focusKey = `turn-summary:${id}`;
    summary.setAttribute(
      "aria-label",
      `${provider} activity: ${turn.tools.length} steps`,
    );
    summary.title = `${turn.tools.length} steps`;
    const label = document.createElement("span");
    label.textContent = provider;
    summary.append(icon("chevron"), label);
    details.append(summary);
    transcript.insertBefore(details, turn.first);
    details.append(...turn.tools);
    for (const message of turn.messages)
      message.querySelector(".message-role")?.remove();
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
