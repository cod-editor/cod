import type { SuggestionRow } from "../browser/address-suggestion-types";

export function suggestionRow({
  title,
  detail,
  selected,
  disabled,
}: SuggestionRow) {
  const button = document.createElement("button");
  button.type = "button";
  button.tabIndex = -1;
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", String(selected));
  if (disabled) button.setAttribute("aria-disabled", "true");
  const titleElement = document.createElement("span");
  const detailElement = document.createElement("small");
  titleElement.textContent = title;
  detailElement.textContent = detail;
  button.append(titleElement, detailElement);
  button.onmousedown = (event) => event.preventDefault();
  return button;
}
