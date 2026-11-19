let sequence = 0;

/** Search keeps keyboard focus; selection belongs to the results. */
export function createSearchList(
  input: HTMLInputElement,
  list: HTMLElement,
  options: {
    selector?: string;
    onSelect?: (row: HTMLButtonElement | undefined) => void;
  } = {},
) {
  let rowSequence = 0;
  let selected: HTMLButtonElement | undefined;
  const prefix = `search-results-${++sequence}`;
  list.id ||= prefix;
  list.classList.add("searchable-list");
  input.setAttribute("aria-controls", list.id);
  const rows = () => [
    ...list.querySelectorAll<HTMLButtonElement>(
      options.selector ?? "button:not([hidden]):not(:disabled)",
    ),
  ];
  function select(button: HTMLButtonElement | undefined, scroll = false): void {
    if (selected === button && button?.classList.contains("selected")) {
      if (scroll) button.scrollIntoView({ block: "nearest" });
      return;
    }
    selected?.classList.remove("selected");
    selected?.removeAttribute("aria-current");
    selected = button;
    selected?.classList.add("selected");
    selected?.setAttribute("aria-current", "true");
    options.onSelect?.(selected);
    if (selected) {
      input.setAttribute("aria-activedescendant", selected.id);
      if (scroll) selected.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }
  function update(preferred?: HTMLButtonElement): void {
    const visible = rows();
    for (const row of list.querySelectorAll<HTMLButtonElement>(
      options.selector ?? "button",
    )) {
      row.id ||= `${prefix}-${++rowSequence}`;
      row.tabIndex = -1;
      row.classList.remove("selected");
      row.removeAttribute("aria-current");
    }
    selected = undefined;
    select(preferred && visible.includes(preferred) ? preferred : visible[0]);
  }
  input.addEventListener("keydown", (event) => {
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.getModifierState("AltGraph")
    )
      return;
    if (event.key === "Enter" && event.repeat) {
      event.preventDefault();
      return;
    }
    const visible = rows();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!visible.length) return;
      const index = selected ? visible.indexOf(selected) : -1;
      const next =
        index < 0
          ? event.key === "ArrowDown"
            ? 0
            : visible.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + visible.length) %
            visible.length;
      select(visible[next], true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (selected && visible.includes(selected)) selected.click();
    }
  });
  list.addEventListener("pointermove", (event) => {
    const row = (event.target as Element).closest<HTMLButtonElement>("button");
    if (row && rows().includes(row)) select(row);
  });
  list.addEventListener("mousedown", (event) => {
    if ((event.target as Element).closest("button")) event.preventDefault();
  });
  return { update, select, selected: () => selected };
}
