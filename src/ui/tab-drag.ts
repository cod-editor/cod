import { tabInsertionIndex } from "../tab-order";
import type { Invoke } from "./contracts";
import type { WorkspaceState } from "../types";

const tabMime = "application/x-cod-tab";

/** Native drag/drop owns cancellation; only a valid drop mutates tab order. */
export function createTabDrag(invoke: Invoke) {
  let dragged:
    | { workspace: string; id: string; focused: boolean; node: HTMLElement }
    | undefined;
  let marker: HTMLElement | undefined;
  let scrolling: number | undefined;
  let scrollTarget: HTMLElement | undefined;
  let scrollDelta = 0;
  let lastX = 0;
  let lastPlacement: (() => void) | undefined;
  const stopScroll = () => {
    if (scrolling !== undefined) cancelAnimationFrame(scrolling);
    scrolling = undefined;
    scrollTarget = undefined;
    scrollDelta = 0;
  };
  const clear = () => {
    stopScroll();
    marker?.remove();
    marker = undefined;
    dragged?.node.removeAttribute("data-dragging");
    dragged = undefined;
    lastPlacement = undefined;
  };
  const scroll = () => {
    scrolling = undefined;
    if (!dragged || !scrollTarget?.isConnected || !scrollDelta) return;
    scrollTarget.scrollLeft += scrollDelta;
    lastPlacement?.();
    scrolling = requestAnimationFrame(scroll);
  };
  function start(
    event: DragEvent,
    node: HTMLElement,
    workspace: string,
    id: string,
  ) {
    clear();
    dragged = {
      workspace,
      id,
      focused: node.contains(document.activeElement),
      node,
    };
    node.dataset.dragging = "true";
    event.dataTransfer?.setData(tabMime, id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  function bind(
    bar: HTMLElement,
    tabs: HTMLElement,
    workspace: WorkspaceState,
    group: NonNullable<WorkspaceState["groups"]>[number],
  ) {
    const accepts = (event: DragEvent) =>
      dragged?.workspace === workspace.id &&
      event.dataTransfer?.types.includes(tabMime) &&
      workspace.panes.some((pane) => pane.id === dragged?.id);
    const placement = (x: number) => {
      const others = [
        ...tabs.querySelectorAll<HTMLElement>("[data-tab-id]"),
      ].filter((tab) => tab.dataset.tabId !== dragged?.id);
      let index = others.findIndex((tab) => {
        const rect = tab.parentElement!.getBoundingClientRect();
        return x < rect.left + rect.width / 2;
      });
      if (index < 0) index = others.length;
      index = tabInsertionIndex(
        workspace,
        others.map((tab) => tab.dataset.tabId!),
        dragged!.id,
        index,
      );
      const before = others[index];
      const rect = (
        before ?? others.at(-1)
      )?.parentElement?.getBoundingClientRect();
      const bounds = bar.getBoundingClientRect();
      const viewport = tabs.getBoundingClientRect();
      const left = rect ? (before ? rect.left : rect.right) : viewport.left;
      marker ??= document.createElement("div");
      marker.className = "tab-insertion-marker";
      marker.setAttribute("aria-hidden", "true");
      marker.style.left = `${Math.max(viewport.left, Math.min(viewport.right, left)) - bounds.left}px`;
      if (marker.parentElement !== bar) bar.append(marker);
      return index;
    };
    bar.ondragover = (event) => {
      if (!accepts(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      lastX = event.clientX;
      lastPlacement = () => placement(lastX);
      placement(lastX);
      const rect = tabs.getBoundingClientRect();
      const delta =
        lastX < rect.left + 28 ? -8 : lastX > rect.right - 28 ? 8 : 0;
      if (!delta) stopScroll();
      else {
        scrollTarget = tabs;
        scrollDelta = delta;
        scrolling ??= requestAnimationFrame(scroll);
      }
    };
    bar.ondragenter = bar.ondragover;
    bar.ondragleave = (event) => {
      if (
        event.relatedTarget instanceof Node &&
        bar.contains(event.relatedTarget)
      )
        return;
      if (marker?.parentElement === bar) marker.remove();
      if (scrollTarget === tabs) stopScroll();
    };
    bar.ondrop = (event) => {
      if (!accepts(event) || !dragged) return;
      event.preventDefault();
      event.stopPropagation();
      const index = placement(event.clientX);
      const { id, focused } = dragged;
      const original = group.paneIds.indexOf(id);
      clear();
      if (original === index) return;
      void invoke("pane.move", {
        workspace: workspace.id,
        id,
        group: group.id,
        index,
      })
        .then(() => {
          if (focused)
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLElement>(`[data-tab-id="${id}"]`)
                ?.focus(),
            );
        })
        .catch(() => undefined);
    };
  }
  return { start, bind, end: clear };
}
