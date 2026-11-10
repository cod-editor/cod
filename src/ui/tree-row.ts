import { icon } from "./controls";

/** Shared disclosure, icon and label geometry for both navigation trees. */
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
  disclosure.append(icon("chevron"));
  disclosure.onclick = (event) => {
    event.stopPropagation();
    toggle();
  };
  const title = document.createElement("span");
  title.className = "tree-label";
  title.textContent = text;
  return { disclosure, label: title, nodes: [disclosure, icon(name), title] };
}
