import {
  searchEngines,
  defaultSearchEngine,
  type SearchEngine,
} from "../browser/address";
import {
  dialogSurface,
  dialogRegions,
  numberStepper,
  uiButton,
  settingEntry,
} from "./primitives";
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
  const surface = pane?.querySelector(".file-editor, .review-source-editor")
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
function fontChoice(
  label: string,
  defaultValue: string,
  save: (value: string) => void,
) {
  const input = document.createElement("select");
  input.setAttribute("aria-label", label);
  const choices = [
    [defaultValue, "System default"],
    ["sans-serif", "Sans serif"],
    ["serif", "Serif"],
    ["monospace", "Monospace"],
  ];
  for (const [value, title] of choices)
    if (![...input.options].some((option) => option.value === value))
      input.add(new Option(title, value));
  const edit = new Option("Custom…", "__custom_font__");
  input.add(edit);
  const custom = document.createElement("input");
  custom.type = "text";
  custom.hidden = true;
  custom.required = true;
  custom.maxLength = 300;
  custom.placeholder = "Font name or family list";
  custom.setAttribute(
    "aria-label",
    `${label.replace(/Font family$/, "custom font family")}`,
  );
  let value = defaultValue;
  let selectedCustom: HTMLOptionElement | undefined;
  input.onchange = () => {
    if (input.selectedOptions[0] === edit) {
      custom.hidden = false;
      custom.value = choices.some(([choice]) => choice === value) ? "" : value;
      custom.focus();
      custom.select();
    } else {
      custom.hidden = true;
      save(input.value);
    }
  };
  custom.onchange = () => {
    if (!custom.checkValidity()) {
      custom.reportValidity();
      return;
    }
    save(custom.value);
  };
  return {
    input,
    custom,
    refresh(next: string, disabled: boolean) {
      value = next;
      const preset = [...input.options].find(
        (option) =>
          option !== edit &&
          option !== selectedCustom &&
          option.value === value,
      );
      if (preset) {
        selectedCustom?.remove();
        selectedCustom = undefined;
        preset.selected = true;
        if (custom !== document.activeElement) custom.hidden = true;
      } else {
        selectedCustom ??= new Option();
        selectedCustom.value = value;
        selectedCustom.text =
          value
            .match(/^\s*(?:"([^"]+)"|'([^']+)'|([^,]+))/)
            ?.slice(1)
            .find(Boolean)
            ?.trim() ?? value;
        input.insertBefore(selectedCustom, edit);
        selectedCustom.selected = true;
      }
      if (custom !== document.activeElement) {
        custom.value = value;
        custom.hidden = true;
      }
      input.disabled = custom.disabled = disabled;
    },
  };
}

export function appearanceDialog(
  shortcuts?: () => void,
  initialQuery = "",
  restoreNativeOrigin?: () => void,
): void {
  if (document.querySelector("dialog[open]")) return;
  const origin = document.activeElement as HTMLElement | null;
  const dialog = dialogSurface("Settings");
  dialog.className = "appearance-settings";
  const { header, body, actions } = dialogRegions(dialog, "Settings");
  const selection =
    origin instanceof HTMLInputElement || origin instanceof HTMLTextAreaElement
      ? {
          start: origin.selectionStart,
          end: origin.selectionEnd,
          direction: origin.selectionDirection,
          top: origin.scrollTop,
          left: origin.scrollLeft,
        }
      : undefined;
  const restore = () => {
    if (document.querySelector("dialog[open]")) return;
    if (restoreNativeOrigin) {
      restoreNativeOrigin();
      return;
    }
    if (!origin?.isConnected) return;
    origin.focus({ preventScroll: true });
    if (
      selection &&
      (origin instanceof HTMLInputElement ||
        origin instanceof HTMLTextAreaElement) &&
      selection.start !== null &&
      selection.end !== null
    ) {
      origin.setSelectionRange(
        selection.start,
        selection.end,
        selection.direction ?? undefined,
      );
      origin.scrollTop = selection.top;
      origin.scrollLeft = selection.left;
    }
  };
  let closing = false;
  const close = () => {
    closing = true;
    dialog.close();
    restore();
  };
  dialog.oncancel = (event) => {
    event.preventDefault();
    close();
  };
  const search = document.createElement("input");
  search.type = "search";
  search.onkeydown = (event) => {
    if (event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  search.placeholder = "Search settings…";
  search.setAttribute("aria-label", "Search settings");
  const error = document.createElement("p");
  error.className = "dialog-error";
  error.setAttribute("role", "status");
  const list = document.createElement("div");
  list.className = "settings-sections";
  const empty = document.createElement("p");
  empty.className = "picker-empty";
  empty.textContent = "No matching settings";
  empty.hidden = true;
  const sections = new Map<string, HTMLElement>();
  const section = (name: string) => {
    let element = sections.get(name);
    if (!element) {
      element = document.createElement("section");
      element.className = "settings-section";
      element.setAttribute("aria-label", `${name} settings`);
      const title = document.createElement("h3");
      title.textContent = name;
      element.append(title);
      sections.set(name, element);
      list.append(element);
    }
    return element;
  };
  const rows = new Map<
    SettingKey,
    {
      row: HTMLElement;
      input: HTMLInputElement | HTMLSelectElement;
      reset: HTMLButtonElement;
      refreshControl?: () => void;
      font?: ReturnType<typeof fontChoice>;
    }
  >();
  for (const [key, spec] of Object.entries(settingsSchema) as [
    SettingKey,
    (typeof settingsSchema)[SettingKey],
  ][]) {
    const label = key.endsWith(".fontSize")
      ? `${spec.group} text size`
      : `${spec.group} ${spec.label}`;
    const save = (value: Settings[SettingKey]) => {
      void update({ [key]: value }).catch((cause) => {
        error.textContent =
          cause instanceof Error ? cause.message : String(cause);
      });
    };
    const font = key.endsWith(".fontFamily")
      ? fontChoice(label, String(spec.default), save)
      : undefined;
    const input =
      font?.input ??
      ("choices" in spec
        ? document.createElement("select")
        : document.createElement("input"));
    input.setAttribute("aria-label", label);
    if (input instanceof HTMLSelectElement && "choices" in spec)
      for (const choice of spec.choices) input.add(new Option(choice, choice));
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
    if (!font)
      input.onchange = () => {
        if (!input.checkValidity()) {
          input.reportValidity();
          return;
        }
        save(
          input instanceof HTMLInputElement && input.type === "checkbox"
            ? input.checked
            : typeof spec.default === "number"
              ? Number(input.value)
              : input.value,
        );
      };
    const { row, reset, control } = settingEntry(spec.label, input);
    row.dataset.settingKey = key;
    reset.setAttribute("aria-label", `Reset ${spec.group} ${spec.label}`);
    let refreshControl: (() => void) | undefined;
    if (input instanceof HTMLInputElement && input.type === "number") {
      const stepper = numberStepper(input);
      control.replaceChildren(stepper.element);
      refreshControl = stepper.refresh;
    }
    if (font) {
      control.classList.add("settings-font");
      control.append(font.custom);
    }
    reset.onclick = () => save(spec.default);
    section(spec.group).append(row);
    rows.set(key, { row, input, reset, refreshControl, font });
  }
  const engine = document.createElement("select");
  engine.setAttribute("aria-label", "Search engine");
  const names = {
    google: "Google",
    duckduckgo: "DuckDuckGo",
    bing: "Bing",
    yandex: "Yandex",
  };
  engine.append(...searchEngines.map((id) => new Option(names[id], id)));
  const browserRow = settingEntry("Search engine", engine);
  browserRow.reset.setAttribute("aria-label", "Reset Browser Search engine");
  section("Browser").append(browserRow.row);
  let browserValue: SearchEngine | undefined;
  let browserBusy = false;
  const refreshBrowser = () => {
    engine.disabled = browserBusy || !browserValue;
    browserRow.reset.disabled =
      browserBusy || !browserValue || browserValue === defaultSearchEngine;
    browserRow.reset.style.visibility =
      browserValue === defaultSearchEngine ? "hidden" : "visible";
    if (browserValue) engine.value = browserValue;
  };
  const loadBrowser = async () => {
    const value = await window.cod.invoke<{ searchEngine: SearchEngine }>({
      op: "browser.settings",
    });
    browserValue = value.searchEngine;
    refreshBrowser();
  };
  const saveBrowser = async (value: string) => {
    resetAll.disabled = true;
    browserBusy = true;
    refreshBrowser();
    try {
      const result = await window.cod.invoke<{ searchEngine: SearchEngine }>({
        op: "browser.settings",
        searchEngine: value,
      });
      browserValue = result.searchEngine;
      error.textContent = current.error ?? "";
    } catch (cause) {
      error.textContent = String(cause);
    } finally {
      browserBusy = false;
      refreshBrowser();
      resetAll.disabled = !!current.error;
    }
  };
  engine.onchange = () => {
    void saveBrowser(engine.value);
  };
  browserRow.reset.onclick = () => {
    void saveBrowser(defaultSearchEngine);
  };
  refreshBrowser();
  void loadBrowser().catch((cause) => {
    error.textContent = String(cause);
  });
  const refresh = () => {
    error.textContent = current.error ?? "";
    for (const [key, { input, reset, font, refreshControl }] of rows) {
      const value = current.values[key];
      if (input instanceof HTMLInputElement && input.type === "checkbox")
        input.checked = value === true;
      else if (input !== document.activeElement) input.value = String(value);
      input.disabled = !!current.error;
      font?.refresh(String(value), !!current.error);
      refreshControl?.();
      reset.style.visibility =
        value === settingsSchema[key].default ? "hidden" : "visible";
      reset.disabled = !!current.error || value === settingsSchema[key].default;
    }
    resetAll.disabled = browserBusy || !!current.error;
  };
  document.addEventListener("cod:settings-changed", refresh);
  const filter = () => {
    const tokens = search.value
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    for (const [key, { row, input }] of rows) {
      const spec = settingsSchema[key];
      const searchable =
        `${key} ${spec.group} ${spec.label} ${input.getAttribute("aria-label")} ${row.textContent} ${current.values[key]}`.toLowerCase();
      row.hidden = !tokens.every((token) => searchable.includes(token));
    }
    browserRow.row.hidden = !tokens.every((token) =>
      `browser.searchengine browser ${browserRow.row.textContent}`
        .toLowerCase()
        .includes(token),
    );
    for (const element of sections.values())
      element.hidden = [
        ...element.querySelectorAll<HTMLElement>(".settings-entry"),
      ].every((row) => row.hidden);
    empty.hidden = [...sections.values()].some((section) => !section.hidden);
  };
  search.oninput = filter;
  search.value = initialQuery;
  filter();
  const utilities = document.createElement("div");
  utilities.className = "ui-dialog-utilities";
  const file = uiButton("Edit settings.json", "quiet");
  file.onclick = () => {
    void window.cod.openSettings().catch((cause) => {
      error.textContent = String(cause);
    });
  };
  utilities.append(file);
  if (shortcuts) {
    const button = uiButton("Keyboard shortcuts", "quiet");
    button.onclick = () => {
      closing = true;
      dialog.close();
      shortcuts();
    };
    utilities.append(button);
  }
  const resetAll = uiButton("Reset defaults", "quiet");
  resetAll.onclick = () => {
    resetAll.disabled = true;
    browserBusy = true;
    refreshBrowser();
    void window.cod
      .invoke<SettingsState>({ op: "settings.update", reset: true })
      .then(receive)
      .catch((cause) => {
        error.textContent = String(cause);
      })
      .finally(async () => {
        try {
          await loadBrowser();
        } catch (cause) {
          error.textContent = String(cause);
        }
        browserBusy = false;
        refreshBrowser();
        resetAll.disabled = !!current.error;
      });
  };
  utilities.append(resetAll);
  const done = uiButton("Done", "primary");
  done.onclick = close;
  actions.append(utilities, done);
  header.append(search, error);
  body.append(list, empty);
  refresh();
  dialog.onclose = () => {
    document.removeEventListener("cod:settings-changed", refresh);
    const abandoned =
      dialog.contains(document.activeElement) ||
      document.activeElement === document.body;
    dialog.remove();
    if (!closing && abandoned) restore();
  };
  document.body.append(dialog);
  dialog.showModal();
  search.focus();
}
