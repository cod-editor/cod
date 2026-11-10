/** Consistent compact label/control spacing in application forms. */
export function formField(
  label: string,
  control: HTMLElement,
): HTMLLabelElement {
  const field = document.createElement("label");
  field.className = "form-field";
  const title = document.createElement("span");
  title.className = "field-label";
  title.textContent = label;
  field.append(title, control);
  return field;
}
