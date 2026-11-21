const number = (
  label: string,
  group: string,
  value: number,
  min: number,
  max: number,
) => ({ label, group, default: value, min, max });
const font = (label: string, group: string, value: string) => ({
  label,
  group,
  default: value,
});
export const settingsSchema = {
  "ui.fontFamily": font(
    "Font family",
    "Interface",
    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  ),
  "ui.fontSize": number("Font size", "Interface", 14, 11, 32),
  "editor.fontFamily": font(
    "Font family",
    "Editor",
    "ui-monospace, SFMono-Regular, Menlo, monospace",
  ),
  "editor.fontSize": number("Font size", "Editor", 16, 10, 40),
  "editor.lineHeight": number("Line height", "Editor", 1.65, 1, 2.5),
  "editor.tabSize": number("Tab width", "Editor", 8, 1, 16),
  "editor.wordWrap": {
    label: "Wrap long lines",
    group: "Editor",
    default: false,
  },
  "chat.fontFamily": font(
    "Font family",
    "Chat",
    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  ),
  "chat.fontSize": number("Font size", "Chat", 15, 10, 40),
  "chat.lineHeight": number("Line height", "Chat", 1.65, 1, 2.5),
  "chat.maxWidth": number("Maximum width", "Chat", 1100, 480, 4000),
  "terminal.fontFamily": font(
    "Font family",
    "Terminal",
    "Menlo, ui-monospace, monospace",
  ),
  "terminal.fontSize": number("Font size", "Terminal", 13, 10, 40),
  "terminal.lineHeight": number("Line height", "Terminal", 1, 1, 2.5),
  "terminal.cursorStyle": {
    label: "Cursor shape",
    group: "Terminal",
    default: "block",
    choices: ["block", "bar", "underline"],
  },
  "terminal.cursorBlink": {
    label: "Blinking cursor",
    group: "Terminal",
    default: false,
  },
  "terminal.scrollback": number(
    "Scrollback lines",
    "Terminal",
    1000,
    100,
    50000,
  ),
  "workspace.defaultHost": {
    label: "Default task host",
    group: "Workspaces",
    default: "local",
    choices: ["local", "linux"],
    choiceLabels: { local: "Local", linux: "Linux" } as Record<string, string>,
  },
} as const;
export type SettingKey = keyof typeof settingsSchema;
export type Settings = {
  [K in SettingKey]: (typeof settingsSchema)[K]["default"] extends number
    ? number
    : (typeof settingsSchema)[K]["default"] extends boolean
      ? boolean
      : (typeof settingsSchema)[K] extends {
            readonly choices: readonly (infer Choice)[];
          }
        ? Choice
        : string;
};
export interface SettingsState {
  values: Settings;
  overrides: Partial<Settings>;
  path: string;
  error?: string;
}
export const defaultSettings = Object.fromEntries(
  Object.entries(settingsSchema).map(([key, spec]) => [key, spec.default]),
) as Settings;
export function validateSettings(value: unknown): Partial<Settings> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Settings must be a JSON object");
  const result: Record<string, unknown> = {};
  for (const [key, setting] of Object.entries(value)) {
    if (!Object.hasOwn(settingsSchema, key))
      throw new Error(`Unknown setting: ${key}`);
    const spec = settingsSchema[key as SettingKey];
    if (typeof setting !== typeof spec.default)
      throw new Error(`Invalid value for ${key}`);
    if (
      typeof setting === "number" &&
      (!Number.isFinite(setting) ||
        !("min" in spec) ||
        setting < spec.min ||
        setting > spec.max ||
        ((key.endsWith("tabSize") || key.endsWith("scrollback")) &&
          !Number.isInteger(setting)))
    )
      throw new Error(`Value out of range for ${key}`);
    if (
      typeof setting === "string" &&
      (!setting.trim() || setting.length > 300 || /[;{}<>\n\r]/.test(setting))
    )
      throw new Error(`Invalid text for ${key}`);
    if (
      "choices" in spec &&
      !(spec.choices as readonly unknown[]).includes(setting)
    )
      throw new Error(`Invalid choice for ${key}`);
    result[key] = setting;
  }
  return result as Partial<Settings>;
}
