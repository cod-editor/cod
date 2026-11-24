import { isPlainEscape } from "../keyboard";
import type { Invoke } from "./contracts";
export function addressSuggestions(
  input: HTMLInputElement,
  invoke: Invoke,
  navigate: (url: string) => void,
  layout: () => void,
  currentUrl: () => string,
) {
  const list = document.createElement("div");
  list.className = "browser-suggestions";
  list.id = `address-results-${crypto.randomUUID()}`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Address suggestions");
  list.hidden = true;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  let revision = 0,
    selected = -1,
    composing = false,
    pending = false,
    selectFirst = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function cancelRefresh() {
    revision++;
    clearTimeout(timer);
    pending = false;
    selectFirst = false;
  }
  function close() {
    cancelRefresh();
    const wasOpen = !list.hidden;
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    selected = -1;
    if (wasOpen) layout();
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
  async function refresh(explicit = false) {
    if (composing) return;
    const query = input.value.trim();
    const unchanged = query === currentUrl();
    if (unchanged && !explicit) {
      close();
      return;
    }
    const generation = ++revision;
    pending = true;
    try {
      const results = await invoke<Array<{ url: string; title: string }>>(
        "browser.suggest",
        { query: unchanged ? "" : query },
        { reportError: false },
      );
      if (
        generation !== revision ||
        document.activeElement !== input ||
        !input.isConnected
      )
        return;
      const items = results.filter((item) => item.url !== currentUrl());
      const wasOpen = !list.hidden;
      const rows = document.createDocumentFragment();
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
          if (generation !== revision) return;
          input.value = item.url;
          close();
          navigate(item.url);
        };
        rows.append(button);
      });
      list.replaceChildren(rows);
      list.hidden = !items.length;
      input.setAttribute("aria-expanded", String(!!items.length));
      select((explicit || selectFirst) && items.length ? 0 : -1);
      selectFirst = false;
      if (wasOpen || items.length) layout();
    } catch {
      if (generation === revision) close();
    } finally {
      if (generation === revision) pending = false;
    }
  }
  function edited() {
    if (composing || input.value.trim() === currentUrl()) {
      close();
      return;
    }
    cancelRefresh();
    select(-1);
    for (const row of list.querySelectorAll("button"))
      row.setAttribute("aria-disabled", "true");
    pending = true;
    timer = setTimeout(() => void refresh(), 80);
  }
  input.addEventListener("input", edited);
  input.addEventListener("compositionstart", () => {
    composing = true;
    close();
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    edited();
  });
  input.addEventListener("focus", close);
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    const rows = list.querySelectorAll<HTMLButtonElement>("button");
    if (event.key === "ArrowDown" && (pending || list.hidden)) {
      event.preventDefault();
      if (pending) selectFirst = true;
      else void refresh(true);
    } else if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      rows.length &&
      !pending &&
      !list.hidden
    ) {
      event.preventDefault();
      select(
        selected < 0
          ? event.key === "ArrowDown"
            ? 0
            : rows.length - 1
          : (selected + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
              rows.length,
      );
    } else if (event.key === "Enter" && selected >= 0 && !list.hidden) {
      event.preventDefault();
      rows[selected]?.click();
    } else if (isPlainEscape(event) && (pending || !list.hidden)) {
      event.preventDefault();
      if (!event.repeat) close();
    }
  });
  return { element: list, close };
}
