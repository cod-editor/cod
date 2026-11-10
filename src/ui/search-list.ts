let sequence = 0;

/** Search keeps keyboard focus; selection belongs to the results. */
export function createSearchList(input: HTMLInputElement, list: HTMLElement) {
  let selected: HTMLButtonElement | undefined;
  const prefix = `search-results-${++sequence}`;
  list.id ||= prefix;
  list.classList.add("searchable-list");
  input.setAttribute("aria-controls", list.id);
  const rows = () => [
    ...list.querySelectorAll<HTMLButtonElement>(
      "button:not([hidden]):not(:disabled)",
    ),
  ];
  function select(button: HTMLButtonElement | undefined, scroll = false): void {
    selected = button;
    for (const row of rows()) {
      const active = row === selected;
      row.classList.toggle("selected", active);
      if (active) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
    if (selected) {
      input.setAttribute("aria-activedescendant", selected.id);
      if (scroll) selected.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }
  function update(preferred?: HTMLButtonElement): void {
    const visible = rows();
    for (const [index, row] of [
      ...list.querySelectorAll<HTMLButtonElement>("button"),
    ].entries()) {
      row.id ||= `${prefix}-${index}`;
      row.tabIndex = -1;
      row.classList.remove("selected");
      row.removeAttribute("aria-current");
    }
    select(preferred && visible.includes(preferred) ? preferred : visible[0]);
  }
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
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
  return { update };
}
