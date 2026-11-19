import type { BackgroundActivity } from "../providers/types";

const stateLabels: Record<BackgroundActivity["state"], string> = {
  running: "Running",
  completed: "Completed",
  interrupted: "Interrupted",
  failed: "Failed",
  unknown: "State unknown",
};

export function backgroundActivity(
  activities: BackgroundActivity[],
  expanded: boolean,
  invalidate: () => void,
): HTMLElement {
  const details = document.createElement("details");
  details.className = "composer-background";
  const summary = document.createElement("summary");
  summary.className = "composer-background-summary";
  summary.dataset.focusKey = "background-activity";
  summary.tabIndex = 0;
  const running = activities.filter((item) => item.state === "running");
  const agents = running.filter((item) => item.kind === "agent").length;
  const shells = running.length - agents;
  const parts = [
    agents ? `${agents} ${agents === 1 ? "agent" : "agents"}` : "",
    shells ? `${shells} ${shells === 1 ? "shell" : "shells"}` : "",
  ].filter(Boolean);
  const name = "Background activity";
  if (parts.length) {
    summary.setAttribute("aria-label", `${name}: ${parts.join(", ")}`);
    for (const part of parts) {
      const count = document.createElement("span");
      count.textContent = part;
      summary.append(count);
    }
  } else summary.textContent = name;
  details.append(summary);
  if (expanded) {
    details.open = true;
    details.append(activityList(activities, running));
  }
  details.ontoggle = () => {
    if (details.isConnected && details.open !== !!details.querySelector("ul"))
      invalidate();
  };
  details.onkeydown = (event) => {
    if (event.key !== "Escape" || !details.open) return;
    event.stopPropagation();
    event.preventDefault();
    details.open = false;
    summary.focus();
  };
  return details;
}

function activityList(
  activities: BackgroundActivity[],
  running: BackgroundActivity[],
): HTMLUListElement {
  const list = document.createElement("ul");
  list.className = "composer-background-list";
  list.setAttribute("aria-label", "Background activity");
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
