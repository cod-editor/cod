/** Present the decision first while retaining the exact provider request for inspection. */
export function permissionContent(value: unknown): HTMLElement {
  const host = document.createElement("div");
  const record = (item: unknown): Record<string, unknown> =>
    item && typeof item === "object" ? (item as Record<string, unknown>) : {};
  const request = record(value),
    tool = record(request.toolCall),
    input = record(tool.rawInput ?? request.input);
  const text = (...items: unknown[]) =>
    items.find((item) => typeof item === "string" && item.trim()) as
      string | undefined;
  const command = text(
    request.command,
    input.command,
    request.path,
    input.path,
    tool.title,
    request.title,
    typeof value === "string" ? value : undefined,
  );
  const directory = text(request.cwd, input.cwd);
  const reason = text(request.reason, tool.reason);
  if (command) {
    const primary = document.createElement("pre");
    primary.className = "permission-details";
    primary.setAttribute("aria-label", "Requested action");
    primary.textContent = command;
    host.append(primary);
  }
  if (directory) {
    const location = document.createElement("p");
    location.className = "permission-location";
    location.textContent = `Directory: ${directory}`;
    host.append(location);
  }
  if (reason) {
    const explanation = document.createElement("p");
    explanation.textContent = reason;
    host.append(explanation);
  }
  if (typeof value !== "string") {
    const technical = document.createElement("details");
    technical.className = "permission-technical";
    technical.dataset.focusKey = "permission-technical";
    const summary = document.createElement("summary");
    summary.textContent = "Request details";
    const raw = document.createElement("pre");
    raw.className = "permission-details";
    raw.setAttribute(
      "aria-label",
      command ? "Technical request details" : "Requested action",
    );
    raw.textContent = JSON.stringify(value, null, 2);
    technical.open = !command;
    technical.append(summary, raw);
    host.append(technical);
  }
  return host;
}
