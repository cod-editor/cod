import { icon } from "./controls";

/** Object-icon toggle and label geometry for workspace rows. */
export function treeRowParts(
  name: string,
  text: string,
  toggle: () => void,
  label: string,
) {
  const disclosure = document.createElement("button");
  disclosure.type = "button";
  disclosure.className = "tree-disclosure";
  disclosure.tabIndex = -1;
  disclosure.setAttribute("aria-label", label);
  disclosure.append(icon(name));
  disclosure.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  };
  disclosure.onclick = (event) => {
    event.stopPropagation();
    toggle();
  };
  const title = document.createElement("span");
  title.className = "tree-label";
  title.textContent = text;
  return { disclosure, label: title, nodes: [disclosure, title] };
}
