import {
  commands,
  formatBinding,
  formatShortcut,
  type CommandId,
  type KeyboardPlatform,
  type KeyboardSurface,
} from "../keyboard";
import type { createFocusManager } from "./focus";
export const keyboardPlatform: KeyboardPlatform = /Mac/.test(navigator.platform)
  ? "darwin"
  : "linux";
export function keyboardSurface(
  element = document.activeElement,
): KeyboardSurface {
  if (element?.closest(".terminal-body")) return "terminal";
  if (element?.closest(".composer")) return "composer";
  if (element?.closest(".file-editor")) return "editor";
  if (element?.closest(".review-line")) return "review";
  return "shell";
}
export function shortcutTitle(id: CommandId, label?: string): string {
  const title = label ?? commands.find((c) => c.id === id)!.title;
  const hint = formatShortcut(id, keyboardPlatform);
  return hint ? `${title} (${hint})` : title;
}
export function showKeyboardShortcuts(
  focus: ReturnType<typeof createFocusManager>,
): void {
  if (document.querySelector("dialog[open]")) return;
  const origin = focus.capture();
  const dialog = document.createElement("dialog");
  dialog.className = "picker search-picker keyboard-shortcuts";
  dialog.setAttribute("aria-label", "Keyboard shortcuts");
  const input = document.createElement("input");
  input.setAttribute("aria-label", "Search shortcuts");
  input.placeholder = "Search commands and shortcuts...";
  const list = document.createElement("div");
  list.className = "shortcut-list";
  list.tabIndex = 0;
  list.setAttribute("role", "region");
  list.setAttribute("aria-label", "Keyboard shortcut reference");
  const fill = () => {
    list.replaceChildren();
    for (const command of commands) {
      const bindings = command.bindings.filter(
        (b) => !b.platform || b.platform === keyboardPlatform,
      );
      const key = bindings
        .map((b) => formatBinding(b, keyboardPlatform))
        .join(" / ");
      if (
        !`${command.title} ${command.category} ${command.aliases.join(" ")} ${key}`
          .toLowerCase()
          .includes(input.value.toLowerCase())
      )
        continue;
      const row = document.createElement("div");
      row.className = "shortcut-row";
      const name = document.createElement("span");
      name.textContent = command.title;
      const hint = document.createElement("kbd");
      hint.textContent = key || "Commands";
      const context = document.createElement("small");
      context.textContent = bindings.length
        ? [...new Set(bindings.flatMap((b) => b.surfaces))]
            .map(
              (s) =>
                ({
                  shell: "Cod controls",
                  editor: "Editor",
                  composer: "Chat input",
                  terminal: "Terminal",
                  browser: "Web page",
                  "agent-page": "Agent page",
                  review: "Review source",
                })[s],
            )
            .join(", ")
        : command.category;
      row.append(name, hint, context);
      list.append(row);
    }
    if (!list.childElementCount) list.textContent = "No matching commands";
  };
  input.oninput = fill;
  dialog.append(input, list);
  document.body.append(dialog);
  dialog.onclose = () => {
    dialog.remove();
    focus.restore(origin);
  };
  fill();
  dialog.showModal();
  input.focus();
}
