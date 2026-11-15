import { actionRow, dialogSurface, uiButton } from "./primitives";
import { readPreference, writePreference } from "./preferences";
import {
  defaultSettings,
  settingsSchema,
  type SettingKey,
  type SettingsState,
  type Settings,
} from "../settings";
let current: SettingsState = {
  values: { ...defaultSettings },
  overrides: {},
  path: "",
};
export const appearanceSettings = () => current.values;
export const terminalTextSize = () => current.values["terminal.fontSize"];
export function applyAppearance(): void {
  const root = document.documentElement;
  for (const surface of ["ui", "editor", "chat", "terminal"] as const) {
    root.style.setProperty(
      `--${surface}-font-size`,
      `${current.values[`${surface}.fontSize`]}px`,
    );
    root.style.setProperty(
      `--${surface}-font-family`,
      current.values[`${surface}.fontFamily`],
    );
  }
  root.style.setProperty(
    "--editor-line-height",
    String(current.values["editor.lineHeight"]),
  );
  root.style.setProperty(
    "--editor-tab-size",
    String(current.values["editor.tabSize"]),
  );
  root.style.setProperty(
    "--editor-white-space",
    current.values["editor.wordWrap"] ? "pre-wrap" : "pre",
  );
  root.style.setProperty(
    "--chat-line-height",
    String(current.values["chat.lineHeight"]),
  );
  root.style.setProperty(
    "--chat-default-max-width",
    `${current.values["chat.maxWidth"]}px`,
  );
  document.dispatchEvent(new Event("cod:settings-changed"));
  window.dispatchEvent(new Event("resize"));
}
function receive(state: SettingsState): void {
  current = state;
  applyAppearance();
}
export async function initializeAppearance(): Promise<void> {
  window.cod.onSettings(receive);
  receive(await window.cod.invoke<SettingsState>({ op: "settings.get" }));
  // Keep existing text sizes when the new settings file is first introduced.
  if (
    !current.error &&
    !Object.keys(current.overrides).length &&
    !readPreference("settings-imported", false)
  ) {
    const legacy = readPreference<Record<string, number>>("font-sizes", {});
    const values: Partial<Settings> = {};
    for (const surface of ["ui", "editor", "chat", "terminal"] as const) {
      const size = legacy[surface];
      if (
        typeof size === "number" &&
        Number.isFinite(size) &&
        size >= 11 &&
        size <= 24
      )
        values[`${surface}.fontSize`] = size;
    }
    if (Object.keys(values).length)
      receive(
        await window.cod.invoke<SettingsState>({
          op: "settings.update",
          values,
        }),
      );
    writePreference("settings-imported", true);
  }
}
async function update(values: Partial<Settings>): Promise<void> {
  receive(
    await window.cod.invoke<SettingsState>({ op: "settings.update", values }),
  );
}
export function changeTextSize(amount: number | "reset"): void {
  const pane = document.activeElement?.closest(".pane");
  const surface = pane?.querySelector(".file-editor")
    ? "editor"
    : pane?.querySelector(".composer")
      ? "chat"
      : pane?.querySelector(".terminal-body")
        ? "terminal"
        : "ui";
  const key = `${surface}.fontSize` as const;
  const spec = settingsSchema[key];
  void update({
    [key]:
      amount === "reset"
        ? spec.default
        : Math.max(spec.min, Math.min(spec.max, current.values[key] + amount)),
  });
}
export function appearanceDialog(
  shortcuts?: () => void,
  browser?: () => void,
): void {
  if (document.querySelector("dialog[open]")) return;
  const origin = document.activeElement as HTMLElement | null;
  const dialog = dialogSurface("Settings");
  dialog.className = "appearance-settings";
  const heading = document.createElement("h2");
  heading.textContent = "Settings";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search settings…";
  search.setAttribute("aria-label", "Search settings");
  const error = document.createElement("p");
  error.className = "dialog-error";
  error.setAttribute("role", "status");
  const list = document.createElement("div");
  list.className = "settings-list";
  const rows = new Map<
    SettingKey,
    {
      row: HTMLElement;
      input: HTMLInputElement | HTMLSelectElement;
      reset: HTMLButtonElement;
    }
  >();
  for (const [key, spec] of Object.entries(settingsSchema) as [
    SettingKey,
    (typeof settingsSchema)[SettingKey],
  ][]) {
    const row = document.createElement("div");
    row.className = "settings-entry";
    const label = document.createElement("label");
    label.className = "setting-row compact";
    const text = document.createElement("span");
    text.textContent = `${spec.group} · ${spec.label}`;
    const input =
      "choices" in spec
        ? document.createElement("select")
        : document.createElement("input");
    input.setAttribute(
      "aria-label",
      key.endsWith(".fontSize")
        ? `${spec.group} text size`
        : `${spec.group} ${spec.label}`,
    );
    if (input instanceof HTMLSelectElement && "choices" in spec)
      for (const choice of spec.choices) {
        const option = document.createElement("option");
        option.value = choice;
        option.textContent = choice;
        input.append(option);
      }
    if (input instanceof HTMLInputElement) {
      input.type =
        typeof spec.default === "boolean"
          ? "checkbox"
          : typeof spec.default === "number"
            ? "number"
            : "text";
      if ("min" in spec) {
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = key.endsWith("lineHeight") ? "0.05" : "1";
      }
    }
    input.onchange = () => {
      if (!input.checkValidity()) {
        input.reportValidity();
        return;
      }
      const value =
        input instanceof HTMLInputElement && input.type === "checkbox"
          ? input.checked
          : typeof spec.default === "number"
            ? Number(input.value)
            : input.value;
      void update({ [key]: value }).catch((cause) => {
        error.textContent =
          cause instanceof Error ? cause.message : String(cause);
      });
    };
    label.append(text, input);
    const reset = uiButton("Reset", "quiet");
    reset.setAttribute("aria-label", `Reset ${spec.group} ${spec.label}`);
    reset.onclick = () => {
      void update({ [key]: spec.default }).catch((cause) => {
        error.textContent = String(cause);
      });
    };
    row.append(label, reset);
    list.append(row);
    rows.set(key, { row, input, reset });
  }
  const refresh = () => {
    error.textContent = current.error ?? "";
    for (const [key, { input, reset }] of rows) {
      const value = current.values[key];
      if (input instanceof HTMLInputElement && input.type === "checkbox")
        input.checked = value === true;
      else if (input !== document.activeElement) input.value = String(value);
      input.disabled = !!current.error;
      reset.style.visibility =
        value === settingsSchema[key].default ? "hidden" : "visible";
      reset.disabled = !!current.error || value === settingsSchema[key].default;
    }
  };
  refresh();
  document.addEventListener("cod:settings-changed", refresh);
  search.oninput = () => {
    const query = search.value.trim().toLowerCase();
    for (const [key, { row }] of rows)
      row.hidden = !`${key} ${row.textContent}`.toLowerCase().includes(query);
  };
  const actions = actionRow();
  const file = uiButton("Edit settings.json");
  file.onclick = () => {
    void window.cod.openSettings().catch((cause) => {
      error.textContent = String(cause);
    });
  };
  actions.append(file);
  if (shortcuts) {
    const button = uiButton("Keyboard shortcuts");
    button.onclick = () => {
      dialog.close();
      shortcuts();
    };
    actions.append(button);
  }
  if (browser) {
    const button = uiButton("Browser settings");
    button.onclick = () => {
      dialog.close();
      browser();
    };
    actions.append(button);
  }
  const resetAll = uiButton("Reset defaults");
  resetAll.onclick = () => {
    void window.cod
      .invoke<SettingsState>({ op: "settings.update", reset: true })
      .then(receive)
      .catch((cause) => {
        error.textContent = String(cause);
      });
  };
  actions.append(resetAll);
  const done = uiButton("Done", "primary");
  done.onclick = () => dialog.close();
  actions.append(done);
  dialog.append(heading, search, error, list, actions);
  dialog.onclose = () => {
    document.removeEventListener("cod:settings-changed", refresh);
    dialog.remove();
    origin?.focus({ preventScroll: true });
  };
  document.body.append(dialog);
  dialog.showModal();
  search.focus();
}
