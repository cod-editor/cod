import { icon } from "./icons";
let fieldSequence = 0;

/** Shared application controls. Feature modules own behavior, not control geometry. */
export function uiButton(
  label: string,
  variant: "default" | "primary" | "quiet" = "default",
  leading?: Node,
) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className =
    variant === "default" ? "ui-button" : `ui-button ${variant}`;
  if (leading) {
    button.classList.add("with-icon");
    button.prepend(leading);
  }
  return button;
}

export function iconButton(
  name: string,
  label: string,
  action: () => void,
): HTMLButtonElement {
  const button = uiButton("");
  button.classList.add("icon-button");
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(name));
  button.onclick = action;
  return button;
}

/** Compact button for a choice menu with a retained caption and fixed chevron. */
export function choiceTrigger(caption: string): HTMLButtonElement {
  const button = uiButton("", "quiet");
  button.classList.add("compact-text", "choice-trigger");
  button.setAttribute("aria-haspopup", "dialog");
  const label = document.createElement("span");
  label.className = "ui-button-label";
  button.append(label, icon("chevron"));
  setChoiceTriggerCaption(button, caption);
  return button;
}

export function setChoiceTriggerCaption(
  button: HTMLButtonElement,
  text: string,
) {
  button.querySelector(".ui-button-label")!.textContent = text;
  button.title = text;
}

export function uiSwitch(): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "ui-switch";
  input.setAttribute("role", "switch");
  return input;
}

/** Wrap a native select. Refresh its options without replacing the trigger. */
export function selectField(input: HTMLSelectElement): HTMLElement {
  const field = document.createElement("span");
  field.className = "ui-select";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.append(document.createElement("selectedcontent"));
  input.prepend(trigger);
  field.append(input, icon("chevron"));
  return field;
}

export function shortcutHint(text = ""): HTMLElement {
  const key = document.createElement("kbd");
  key.className = "shortcut-hint";
  key.textContent = text;
  key.setAttribute("aria-hidden", "true");
  return key;
}
export function keyHintButton(button: HTMLButtonElement, key: string) {
  button.classList.add("with-key-hint");
  button.append(shortcutHint(key));
  return button;
}
export function pickerShortcuts(activate: string): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = "picker-footer";
  footer.setAttribute("aria-hidden", "true");
  footer.setAttribute("data-no-results", "");
  for (const [label, keys] of [
    ["Select", "↑ ↓"],
    [activate, "Enter"],
    ["Close", "Esc"],
  ]) {
    const item = document.createElement("span");
    item.toggleAttribute("data-result-shortcut", label !== "Close");
    item.append(label, shortcutHint(keys));
    footer.append(item);
  }
  return footer;
}
export function actionRow(...children: Array<Node | string>) {
  const row = document.createElement("div");
  row.className = "ui-actions";
  row.append(...children);
  return row;
}
export function dialogSurface(label: string) {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", label);
  return dialog;
}
export function toolbar(...children: Array<Node | string>) {
  const bar = document.createElement("div");
  bar.className = "ui-toolbar";
  bar.append(...children);
  return bar;
}

export function settingEntry(
  title: string,
  input: HTMLInputElement | HTMLSelectElement,
  description?: string,
) {
  const row = document.createElement("div");
  row.className = "settings-entry";
  const line = document.createElement("div");
  line.className = "setting-row compact";
  const label = document.createElement("label");
  label.textContent = title;
  input.id ||= `setting-field-${++fieldSequence}`;
  label.htmlFor = input.id;
  if (description) {
    const detail = document.createElement("small");
    detail.className = "settings-note";
    detail.id = `${input.id}-description`;
    detail.textContent = description;
    label.append(detail);
    input.setAttribute("aria-describedby", detail.id);
  }
  const control = document.createElement("div");
  control.className = "setting-control";
  control.append(
    input instanceof HTMLSelectElement ? selectField(input) : input,
  );
  const reset = uiButton("", "quiet", icon("reset"));
  reset.classList.add("icon-button", "compact");
  reset.title = `Reset ${title.replace(" · ", " ")}`;
  reset.setAttribute("aria-label", `Reset ${title.replace(" · ", " ")}`);
  const valueRow = document.createElement("div");
  valueRow.className = "setting-value";
  valueRow.append(control, reset);
  line.append(label, valueRow);
  row.append(line);
  return { row, input, reset, label, control };
}

/** Secondary context using shared button geometry. */
export function describeButton(button: HTMLButtonElement, description: string) {
  const label = document.createElement("span");
  label.className = "ui-button-label";
  label.append(...button.childNodes);
  const detail = document.createElement("small");
  detail.className = "ui-button-description";
  detail.textContent = description;
  button.append(label, detail);
  return button;
}

/** Shared long-dialog regions; the caller owns content, actions and focus. */
export function dialogRegions(dialog: HTMLDialogElement, title: string) {
  dialog.classList.add("ui-dialog");
  const header = document.createElement("header");
  header.className = "ui-dialog-header";
  const heading = document.createElement("h2");
  heading.textContent = title;
  header.append(heading);
  const body = document.createElement("div");
  body.className = "ui-dialog-body";
  const actions = document.createElement("footer");
  actions.className = "ui-dialog-actions";
  dialog.append(header, body, actions);
  return { header, body, actions };
}

/** Keep native number validation and the caller's persistence handler authoritative. */
export function numberStepper(input: HTMLInputElement) {
  if (input.type !== "number") throw new Error("A number input is required");
  const element = document.createElement("div");
  element.className = "ui-number-stepper";
  const down = uiButton("-", "quiet");
  const up = uiButton("+", "quiet");
  element.append(down, input, up);
  function refresh() {
    const name =
      input.getAttribute("aria-label") ??
      input.labels?.[0]?.textContent?.trim() ??
      "value";
    down.setAttribute("aria-label", `Decrease ${name}`);
    up.setAttribute("aria-label", `Increase ${name}`);
    const value = input.valueAsNumber;
    const min = input.min === "" ? -Infinity : Number(input.min);
    const max = input.max === "" ? Infinity : Number(input.max);
    down.disabled =
      input.disabled ||
      input.readOnly ||
      (Number.isFinite(value) && value <= min);
    up.disabled =
      input.disabled ||
      input.readOnly ||
      (Number.isFinite(value) && value >= max);
  }
  function step(direction: number) {
    if (input.disabled || input.readOnly) return;
    const previous = input.value;
    input.stepUp(direction);
    if (input.value !== previous) {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    refresh();
  }
  down.onclick = () => step(-1);
  up.onclick = () => step(1);
  input.addEventListener("input", refresh);
  input.addEventListener("change", refresh);
  refresh();
  return { element, refresh };
}
