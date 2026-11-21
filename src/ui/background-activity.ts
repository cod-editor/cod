import { uiButton } from "./primitives";
import type { BackgroundActivity } from "../providers/types";

const stateLabels: Record<BackgroundActivity["state"], string> = {
  running: "Running",
  completed: "Completed",
  interrupted: "Interrupted",
  failed: "Failed",
  unknown: "State unknown",
};

export function backgroundActivity(
  conversationId: string,
  activities: BackgroundActivity[],
  expanded: BackgroundActivity["kind"] | undefined,
  choose: (kind: BackgroundActivity["kind"] | undefined) => void,
): HTMLElement {
  const host = document.createElement("span");
  host.className = "composer-background";
  for (const [kind, label, singular] of [
    ["agent", "Agents", "agent"],
    ["command", "Shells", "shell"],
  ] as const) {
    const items = activities.filter((item) => item.kind === kind);
    if (!items.length) continue;
    const running = items.filter((item) => item.state === "running");
    const count = running.length;
    const id = `background-${conversationId}-${kind}`;
    const trigger = uiButton(
      count
        ? `${count} ${count === 1 ? singular : label.toLowerCase()}`
        : label,
      "quiet",
    );
    trigger.classList.add("composer-background-trigger", "embedded");
    trigger.dataset.focusKey = `background:${kind}`;
    trigger.dataset.running = String(count > 0);
    trigger.setAttribute(
      "aria-label",
      count ? `${label}, ${count} running` : `Recent ${label.toLowerCase()}`,
    );
    trigger.setAttribute("aria-expanded", String(expanded === kind));
    if (expanded === kind) trigger.setAttribute("aria-controls", id);
    trigger.onclick = (event) =>
      choose(
        (event.currentTarget as HTMLButtonElement).getAttribute(
          "aria-expanded",
        ) === "true"
          ? undefined
          : kind,
      );
    host.append(trigger);
    if (expanded === kind)
      host.append(
        activityList(id, `Background ${label.toLowerCase()}`, items, running),
      );
  }
  return host;
}

export function dismissBackgroundActivity(target: Element): boolean {
  const trigger = target
    .closest(".chat-body")
    ?.querySelector<HTMLButtonElement>(
      '.composer-background-trigger[aria-expanded="true"]',
    );
  if (!trigger) return false;
  const restoreTrigger =
    target === trigger || !!target.closest(".composer-background-list");
  trigger.click();
  if (restoreTrigger) trigger.focus({ preventScroll: true });
  return true;
}

function activityList(
  id: string,
  label: string,
  activities: BackgroundActivity[],
  running: BackgroundActivity[],
): HTMLUListElement {
  const list = document.createElement("ul");
  list.className = "composer-background-list";
  list.id = id;
  list.setAttribute("aria-label", label);
  list.tabIndex = 0;
  const ordered = [
    ...running,
    ...activities.filter((item) => item.state !== "running").reverse(),
  ];
  for (const item of ordered) {
    const row = document.createElement("li");
    row.dataset.toolId = item.id;
    const label = document.createElement("strong");
    label.textContent = item.label;
    const status = document.createElement("div");
    const seconds = Math.max(
      0,
      Math.floor(((item.finishedAt ?? Date.now()) - item.startedAt) / 1000),
    );
    const parts = [
      item.owner ?? (item.kind === "command" ? "Main agent" : "Subagent"),
      stateLabels[item.state],
      item.state === "running" || item.state === "unknown" ? "" : `${seconds}s`,
      item.exitCode === undefined ? "" : `Exit ${item.exitCode}`,
    ]
      .filter(Boolean)
      .join(" · ");
    status.textContent = parts;
    if (item.state === "running") {
      const elapsed = document.createElement("span");
      elapsed.dataset.backgroundStarted = String(item.startedAt);
      elapsed.textContent = ` · ${seconds}s`;
      status.append(elapsed);
    }
    row.append(label, status);
    if (item.result) {
      const output = document.createElement("pre");
      output.textContent = item.result;
      row.append(output);
    }
    list.append(row);
  }
  return list;
}
