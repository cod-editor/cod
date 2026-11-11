/** Shared application controls. Feature modules own behavior, not control geometry. */
export function uiButton(
  label: string,
  variant: "default" | "primary" | "quiet" = "default",
) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className =
    variant === "default" ? "ui-button" : `ui-button ${variant}`;
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
