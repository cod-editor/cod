import { readPreference, writePreference } from "./preferences";

type TextSurface = "ui" | "editor" | "chat" | "terminal";
const defaults: Record<TextSurface, number> = {
  ui: 14,
  editor: 16,
  chat: 15,
  terminal: 13,
};
let sizes = { ...defaults };
export const terminalTextSize = () => sizes.terminal;
export function applyAppearance(): void {
  const stored = readPreference<Partial<typeof defaults>>("font-sizes", {});
  for (const key of Object.keys(defaults) as TextSurface[]) {
    const value = stored[key];
    sizes[key] =
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(11, Math.min(24, value))
        : defaults[key];
    document.documentElement.style.setProperty(
      `--${key}-font-size`,
      `${sizes[key]}px`,
    );
  }
}
function update(key: TextSurface, value: number): void {
  sizes[key] = Math.max(11, Math.min(24, value));
  writePreference("font-sizes", sizes);
  applyAppearance();
  window.dispatchEvent(new Event("resize"));
}
export function changeTextSize(amount: number | "reset"): void {
  const pane = document.activeElement?.closest(".pane");
  const key: TextSurface = pane?.querySelector(".file-editor")
    ? "editor"
    : pane?.querySelector(".composer")
      ? "chat"
      : pane?.querySelector(".terminal-body")
        ? "terminal"
        : "ui";
  update(key, amount === "reset" ? defaults[key] : sizes[key] + amount);
}
export function appearanceDialog(shortcuts?: () => void): void {
  if (document.querySelector("dialog[open]")) return;
  const dialog = document.createElement("dialog");
  dialog.className = "appearance-settings";
  dialog.setAttribute("aria-label", "Settings");
  const heading = document.createElement("h2");
  heading.textContent = "Settings";
  dialog.append(heading);
  for (const [key, name] of [
    ["ui", "Interface text"],
    ["editor", "Editor text"],
    ["chat", "Chat text"],
    ["terminal", "Terminal text"],
  ] as const) {
    const row = document.createElement("label");
    row.className = "setting-row";
    const label = document.createElement("span");
    label.textContent = name;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "11";
    input.max = "24";
    input.step = "1";
    input.value = String(sizes[key]);
    input.setAttribute("aria-label", `${name} size`);
    input.onchange = () => {
      if (input.validity.valid && input.value) update(key, Number(input.value));
    };
    row.append(label, input);
    dialog.append(row);
  }
  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent = "Sizes are in pixels. Web pages keep their own text size.";
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const reset = document.createElement("button");
  reset.textContent = "Reset defaults";
  reset.onclick = () => {
    for (const key of Object.keys(defaults) as TextSurface[])
      update(key, defaults[key]);
    dialog
      .querySelectorAll<HTMLInputElement>("input")
      .forEach(
        (input, i) => (input.value = String(Object.values(defaults)[i])),
      );
  };
  const done = document.createElement("button");
  done.textContent = "Done";
  done.className = "primary";
  done.onclick = () => dialog.close();
  if (shortcuts) {
    const keys = document.createElement("button");
    keys.textContent = "Keyboard shortcuts";
    keys.onclick = () => {
      dialog.close();
      shortcuts();
    };
    actions.append(keys);
  }
  actions.append(reset, done);
  dialog.append(note, actions);
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}
