import type { AppState } from "../types";
import type { Invoke } from "./contracts";
import { menu } from "./controls";
import { siteFavicon, siteIcon } from "./site-icon";

export function createBrowserHome(
  getState: () => AppState,
  invoke: Invoke,
  navigate: (url: string) => void,
) {
  const element = document.createElement("section");
  element.className = "browser-home";
  element.setAttribute("aria-label", "Browser home");
  const grid = document.createElement("div");
  grid.className = "browser-home-grid";
  const form = document.createElement("form");
  form.className = "browser-home-editor";
  form.hidden = true;
  const address = document.createElement("input");
  address.placeholder = "Website address";
  address.setAttribute("aria-label", "Pinned site address");
  address.required = true;
  const title = document.createElement("input");
  title.placeholder = "Name";
  title.setAttribute("aria-label", "Pinned site name");
  const save = document.createElement("button");
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const error = document.createElement("span");
  error.setAttribute("role", "alert");
  form.append(address, title, save, cancel, error);
  element.append(grid, form);
  let signature = "";
  const marks = new Map<string, HTMLElement>();
  function updateMark(site: { url: string; title: string; favicon?: string }) {
    const mark = marks.get(site.url)!;
    const favicon = siteFavicon(site.favicon);
    const previous = mark.querySelector("img");
    if (favicon) {
      if (previous?.getAttribute("src") !== favicon)
        mark.replaceChildren(siteIcon(favicon));
    } else if (previous || !mark.textContent) {
      mark.textContent = [...site.title][0]?.toUpperCase() ?? "?";
    }
  }
  let origin: HTMLElement | undefined;
  const close = () => {
    form.hidden = true;
    (origin?.isConnected ? origin : grid.querySelector("button"))?.focus();
  };
  cancel.onclick = close;
  form.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  function edit(button: HTMLElement, site?: { url: string; title: string }) {
    origin = button;
    address.value = site?.url ?? "";
    address.readOnly = !!site;
    title.value = site?.title ?? "";
    error.textContent = "";
    form.hidden = false;
    (site ? title : address).focus();
    (site ? title : address).select();
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const value = address.value.trim();
      const url = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
        ? value
        : `https://${value}`;
      await invoke(
        "browser.pin",
        { url, title: title.value },
        { reportError: false },
      );
      close();
    } catch (failure) {
      error.textContent =
        failure instanceof Error ? failure.message : String(failure);
    } finally {
      save.disabled = false;
    }
  };
  return {
    element,
    update() {
      const sites = getState().pinnedSites ?? [];
      const next = JSON.stringify(sites.map(({ url, title }) => [url, title]));
      if (signature === next) {
        for (const site of sites) updateMark(site);
        return;
      }
      signature = next;
      marks.clear();
      grid.replaceChildren();
      for (const site of sites) {
        const button = document.createElement("button");
        button.className = "browser-home-site";
        button.title = site.url;
        const mark = document.createElement("span");
        mark.className = "browser-home-monogram";
        mark.setAttribute("aria-hidden", "true");
        marks.set(site.url, mark);
        updateMark(site);
        let hash = 0;
        for (const char of new URL(site.url).hostname)
          hash = (hash * 31 + char.charCodeAt(0)) | 0;
        mark.style.backgroundColor = `hsl(${Math.abs(hash) % 360} 28% 35%)`;
        const label = document.createElement("span");
        label.textContent = site.title;
        button.append(mark, label);
        button.setAttribute("aria-haspopup", "dialog");
        button.onclick = () => navigate(site.url);
        const actions = (anchor: HTMLElement | { x: number; y: number }) =>
          menu(
            anchor,
            [
              { label: "Rename", run: () => edit(button, site) },
              {
                label: "Unpin",
                run: () => {
                  void invoke("browser.unpin", { url: site.url });
                },
              },
            ],
            {
              trigger: button,
              restoreFocus: () => button.focus({ preventScroll: true }),
            },
          );
        button.oncontextmenu = (event) => {
          event.preventDefault();
          actions({ x: event.clientX, y: event.clientY });
        };
        button.onkeydown = (event) => {
          if (
            event.isComposing ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            (event.key !== "ContextMenu" &&
              !(event.shiftKey && event.key === "F10"))
          )
            return;
          event.preventDefault();
          if (!event.repeat) actions(button);
        };
        grid.append(button);
      }
      const add = document.createElement("button");
      add.className = "browser-home-site browser-home-add";
      add.textContent = "+";
      add.setAttribute("aria-label", "Pin a site");
      add.title = "Pin a site";
      add.onclick = () => edit(add);
      grid.append(add);
    },
  };
}
