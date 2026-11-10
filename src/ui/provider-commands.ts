import type { InspectionSection, ProviderInspection } from "../providers/types";
import type { Invoke } from "./contracts";
import { createSearchList } from "./search-list";
import {
  parseProviderCommand,
  providerCommandSections,
} from "../provider-commands";
interface Skill {
  name: string;
  path: string;
}
interface Options {
  id: string;
  invoke: Invoke;
  insertSkill?: (skill: Skill) => void;
}
const titles: Record<InspectionSection, string> = {
  status: "Session status",
  skills: "Skills",
  plugins: "Plugins",
  config: "Provider settings",
  agents: "Child sessions",
};
const descriptions: Record<InspectionSection, string> = {
  status: "Context usage and account limits",
  skills: "Choose a skill for this prompt",
  plugins: "Installed provider plugins",
  config: "Effective settings for this session",
  agents: "Agents started by this session",
};
function fieldLabel(label: string): string {
  const names: Record<string, string> = {
    model_provider: "Model provider",
    model_reasoning_effort: "Reasoning effort",
    approval_policy: "Approval policy",
    sandbox_mode: "Sandbox",
    web_search: "Web search",
    model: "Model",
    personality: "Personality",
  };
  return (
    names[label] ??
    label.replace(/(\d+) min\b/g, (_, n: string) =>
      Number(n) % 60 === 0 ? `${Number(n) / 60} hour` : `${n} minute`,
    )
  );
}
function fieldValue(value: string): string {
  return value.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, (stamp) =>
    new Date(stamp).toLocaleString(),
  );
}
export function showProviderCommands(
  options: Options,
  section?: InspectionSection,
): void {
  if (document.querySelector("dialog[open]")) return;
  const searchable = !section || section === "skills";
  const dialog = document.createElement("dialog");
  dialog.className = searchable
    ? "picker search-picker provider-inspector"
    : "provider-inspector";
  dialog.setAttribute(
    "aria-label",
    section ? `Session ${section}` : "Session commands",
  );
  const input = document.createElement("input");
  input.placeholder =
    section === "skills" ? "Search skills..." : "Session commands...";
  input.setAttribute("aria-label", "Filter session commands");
  const list = document.createElement("div");
  list.className = searchable ? "command-list" : "inspection-entries";
  const content = document.createElement("div");
  content.className = "inspection-content";
  content.setAttribute("aria-live", "polite");
  const close = document.createElement("button");
  close.textContent = "Done";
  close.onclick = () => dialog.close();
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  actions.append(close);
  if (searchable) dialog.append(input, list, content);
  else {
    const heading = document.createElement("h2");
    heading.textContent = titles[section!];
    content.append(list);
    dialog.append(heading, content, actions);
  }
  document.body.append(dialog);
  const selection = searchable ? createSearchList(input, list) : undefined;
  input.oninput = () => {
    for (const child of [...list.children] as HTMLElement[])
      child.hidden = !child.textContent
        ?.toLowerCase()
        .includes(input.value.toLowerCase());
    selection?.update();
  };
  function entry(label: string, detail: string, action?: () => void): void {
    const row = document.createElement(action ? "button" : "div");
    row.className = "inspection-entry";
    const title = document.createElement("span");
    title.textContent = label;
    const secondary = document.createElement("small");
    secondary.textContent = detail;
    row.append(title, secondary);
    if (action) {
      row.setAttribute("aria-label", label);
      row.onclick = action;
    }
    list.append(row);
  }
  if (!section) {
    for (const command of providerCommandSections)
      entry(`/${command}`, descriptions[command], () => {
        dialog.close();
        showProviderCommands(options, command);
      });
    selection?.update();
  } else {
    const status = document.createElement("p");
    status.textContent = "Reading provider details...";
    content.append(status);
    void options
      .invoke<ProviderInspection>(
        "conversation.native-inspect",
        { id: options.id, section },
        { reportError: false },
      )
      .then((result) => {
        if (!dialog.isConnected) return;
        status.remove();
        if (result.fields.length) {
          const fields = document.createElement("dl");
          fields.className = "inspection-fields";
          for (const field of result.fields) {
            const label = document.createElement("dt");
            label.textContent = fieldLabel(field.label);
            const value = document.createElement("dd");
            const identity = /session|directory/i.test(field.label);
            value.textContent = identity
              ? field.value
              : fieldValue(field.value);
            value.title = field.value;
            if (identity) value.className = "inspection-identity";
            fields.append(label, value);
          }
          content.prepend(fields);
        }
        for (const item of result.entries)
          entry(
            item.label,
            [item.detail, item.skill?.path].filter(Boolean).join("\n"),
            item.skill && options.insertSkill
              ? () => {
                  dialog.close();
                  options.insertSkill!(item.skill!);
                }
              : undefined,
          );
        if (
          !result.entries.length &&
          ["skills", "plugins", "agents"].includes(section)
        ) {
          const empty = document.createElement("p");
          empty.textContent = `No ${section} reported.`;
          content.append(empty);
        }
        for (const message of result.unavailable) {
          const note = document.createElement("p");
          note.className = "inspection-note";
          note.textContent = message;
          content.append(note);
        }
        selection?.update();
      })
      .catch((error) => {
        status.textContent =
          error instanceof Error ? error.message : String(error);
        status.setAttribute("role", "alert");
      });
  }
  dialog.onclose = () => dialog.remove();
  dialog.showModal();
  if (searchable) input.focus();
  else close.focus();
}
export function routeProviderCommand(text: string, options: Options): boolean {
  const command = parseProviderCommand(text);
  if (!command) return false;
  if (command === "unknown")
    throw new Error(
      "Unknown session command. Use /help to see commands, or add ordinary text to send it as a prompt.",
    );
  showProviderCommands(options, command === "commands" ? undefined : command);
  return true;
}
