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
) {
  const row = document.createElement("div");
  row.className = "settings-entry";
  const label = document.createElement("label");
  label.className = "setting-row compact";
  const text = document.createElement("span");
  text.textContent = title;
  label.append(text, input);
  const reset = uiButton("Reset", "quiet");
  reset.setAttribute("aria-label", `Reset ${title.replace(" · ", " ")}`);
  row.append(label, reset);
  return { row, input, reset };
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
