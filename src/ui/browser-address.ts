import type { Invoke } from "./contracts";
export function addressSuggestions(
  input: HTMLInputElement,
  invoke: Invoke,
  navigate: (url: string) => void,
  layout: () => void,
) {
  const list = document.createElement("div");
  list.className = "browser-suggestions";
  list.id = `address-results-${crypto.randomUUID()}`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Address suggestions");
  list.hidden = true;
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  let revision = 0,
    selected = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function close() {
    revision++;
    clearTimeout(timer);
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    selected = -1;
    layout();
  }
  function select(index: number) {
    const rows = [...list.querySelectorAll<HTMLButtonElement>("button")];
    selected = index;
    rows.forEach((row, i) =>
      row.setAttribute("aria-selected", String(i === index)),
    );
    if (rows[index]) {
      input.setAttribute("aria-activedescendant", rows[index].id);
      rows[index].scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }
  async function refresh() {
    const generation = ++revision;
    try {
      const items = await invoke<Array<{ url: string; title: string }>>(
        "browser.suggest",
        { query: input.value },
        { reportError: false },
      );
      if (
        generation !== revision ||
        document.activeElement !== input ||
        !input.isConnected
      )
        return;
      list.replaceChildren();
      selected = -1;
      items.forEach((item, i) => {
        const button = document.createElement("button");
        button.type = "button";
        button.tabIndex = -1;
        button.id = `${list.id}-${i}`;
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", "false");
        const title = document.createElement("span"),
          url = document.createElement("small");
        title.textContent = item.title;
        url.textContent = item.url;
        button.append(title, url);
        button.onmousedown = (event) => event.preventDefault();
        button.onclick = () => {
          input.value = item.url;
          close();
          navigate(item.url);
        };
        list.append(button);
      });
      list.hidden = !items.length;
      input.setAttribute("aria-expanded", String(!!items.length));
      input.removeAttribute("aria-activedescendant");
      layout();
    } catch {
      if (generation === revision) close();
    }
  }
  input.addEventListener("input", () => {
    close();
    timer = setTimeout(() => void refresh(), 80);
  });
  input.addEventListener("focus", () => void refresh());
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    const rows = list.querySelectorAll<HTMLButtonElement>("button");
    if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      rows.length &&
      !list.hidden
    ) {
      event.preventDefault();
      select(
        (selected + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
          rows.length,
      );
    } else if (event.key === "Enter" && selected >= 0 && !list.hidden) {
      event.preventDefault();
      rows[selected]?.click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  return { element: list, close };
}
