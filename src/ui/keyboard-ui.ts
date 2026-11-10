import {
  commands,
  localGestures,
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
    const row = (
      title: string,
      keys: string,
      context: string,
      aliases = "",
    ) => {
      if (
        !`${title} ${keys} ${context} ${aliases}`
          .toLowerCase()
          .includes(input.value.toLowerCase())
      )
        return;
      const item = document.createElement("div");
      item.className = "shortcut-row";
      const name = document.createElement("span");
      name.textContent = title;
      const hint = document.createElement("kbd");
      hint.textContent = keys;
      const scope = document.createElement("small");
      scope.textContent = context;
      item.append(name, hint, scope);
      list.append(item);
    };
    for (const command of commands) {
      const bindings = command.bindings.filter(
        (b) => !b.platform || b.platform === keyboardPlatform,
      );
      const keys = [
        ...new Set(bindings.map((b) => formatBinding(b, keyboardPlatform))),
      ].join(" / ");
      const surfaces = [...new Set(bindings.flatMap((b) => b.surfaces))];
      const context =
        surfaces.length === 7
          ? "Anywhere in Cod"
          : surfaces.length
            ? surfaces
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
      row(
        command.title,
        keys || "Commands",
        context,
        command.aliases.join(" "),
      );
    }
    for (const gesture of localGestures)
      row(
        gesture.title,
        gesture.keys.join(" / "),
        gesture.context,
        gesture.aliases?.join(" ") ?? "",
      );
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
