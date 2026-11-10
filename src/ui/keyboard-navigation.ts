import { focusReadyEditor } from "./document-views";
import type { AppState, PaneState } from "../types";
import type { Invoke } from "./contracts";
import { paneRegions } from "./pane-layout";

/** Region traversal belongs to the shell; Tab continues to navigate local controls. */
export function createKeyboardNavigation(
  getState: () => AppState,
  invoke: Invoke,
  panes: HTMLElement,
  tree: HTMLElement,
  nativeFocus: (id: string) => void,
) {
  const workspace = () =>
    getState().workspaces.find((w) => w.id === getState().activeWorkspaceId);
  const visible = (element: HTMLElement | null): element is HTMLElement =>
    !!element && element.getClientRects().length > 0;
  const nextFrame = () =>
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  async function content(pane: PaneState): Promise<void> {
    const host = panes.querySelector<HTMLElement>(
      `[data-pane-id="${pane.id}"]`,
    );
    if (!host) return;
    if (
      pane.kind === "browser" &&
      !getState().browsers.find((b) => b.id === pane.browserId)?.error
    ) {
      nativeFocus(pane.browserId);
      await window.cod.browserFocus(pane.browserId);
      return;
    }
    const primary =
      pane.kind === "conversation" ||
      (pane.kind === "document" && !pane.filePath)
        ? ".composer textarea"
        : pane.kind === "document"
          ? ".file-editor"
          : pane.kind === "terminal"
            ? ".xterm-helper-textarea"
            : pane.kind === "review"
              ? '.review-line[tabindex="0"]'
              : ".browser-failure button";
    const target =
      host.querySelector<HTMLElement>(primary) ??
      host.querySelector<HTMLElement>(
        'button, textarea, input, [tabindex="0"]',
      );
    if (
      target instanceof HTMLTextAreaElement &&
      target.classList.contains("file-editor")
    )
      focusReadyEditor(target, () => workspace()?.activePaneId === pane.id);
    else if (target) target.focus({ preventScroll: true });
    else {
      host.tabIndex = 0;
      host.focus({ preventScroll: true });
    }
  }
  async function focusPane(id: string): Promise<void> {
    const w = getState().workspaces.find((w) =>
        w.panes.some((p) => p.id === id),
      ),
      pane = w?.panes.find((p) => p.id === id);
    if (!w || !pane) return;
    await invoke("pane.focus", { workspace: w.id, id });
    if (pane.kind === "conversation")
      await invoke("conversation.acknowledge", { id: pane.conversationId });
    await nextFrame();
    await content(pane);
  }
  async function spatial(index: number, workspaceId?: string): Promise<void> {
    const w = workspaceId
      ? getState().workspaces.find((w) => w.id === workspaceId)
      : workspace();
    if (!w) return;
    const region = paneRegions(w)
      .filter((r) => !r.id.startsWith("missing-"))
      .sort((a, b) => a.x - b.x || a.y - b.y)[index];
    const group = w.groups?.find((g) => g.id === region?.id);
    if (group) await focusPane(group.activePaneId);
  }
  async function cycleTab(
    delta: number,
    workspaceId?: string,
    paneId?: string,
  ): Promise<void> {
    const w = workspaceId
        ? getState().workspaces.find((w) => w.id === workspaceId)
        : workspace(),
      group = w?.groups?.find((g) =>
        g.paneIds.includes(paneId ?? w.activePaneId),
      );
    if (!group) return;
    const ids = group.paneIds.filter(
      (id) => w!.panes.find((p) => p.id === id)?.kind !== "empty",
    );
    if (!ids.length) return;
    await focusPane(
      ids[
        (ids.indexOf(paneId ?? w!.activePaneId) + delta + ids.length) %
          ids.length
      ],
    );
  }
  async function cycleRegion(delta: number, browserId?: string): Promise<void> {
    const regions: {
      element: HTMLElement;
      run: () => void | Promise<void>;
      browserId?: string;
    }[] = [];
    const add = (
      element: HTMLElement | null,
      target?: () => void | Promise<void>,
    ) => {
      if (visible(element))
        regions.push({
          element,
          run: target ?? (() => element.focus({ preventScroll: true })),
        });
    };
    add(document.querySelector("#workspace-selector"));
    add(tree.closest<HTMLElement>(".sidebar"), () =>
      (
        tree.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ??
        tree.querySelector<HTMLElement>('[role="treeitem"]')
      )?.focus(),
    );
    const files = document.querySelector<HTMLElement>("#project-panel");
    add(files, () =>
      (
        files?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ??
        files
      )?.focus(),
    );
    const w = workspace();
    for (const group of panes.querySelectorAll<HTMLElement>(".tab-group")) {
      const tabs = group.querySelector<HTMLElement>(".tab-bar");
      add(tabs, () =>
        (
          tabs?.querySelector<HTMLElement>(
            '[role="tab"][aria-selected="true"]',
          ) ?? tabs?.querySelector<HTMLElement>("button")
        )?.focus(),
      );
      const host = group.querySelector<HTMLElement>("[data-pane-id]");
      const pane = w?.panes.find((p) => p.id === host?.dataset.paneId);
      if (host && pane && visible(host))
        regions.push({
          element: host,
          run: () => content(pane),
          ...(pane.kind === "browser" ? { browserId: pane.browserId } : {}),
        });
    }
    const footer = document.querySelector<HTMLElement>("footer");
    add(footer, () =>
      footer?.querySelector<HTMLElement>("button:not(:disabled)")?.focus(),
    );
    if (!regions.length) return;
    const index = regions.findIndex((r) =>
      browserId
        ? r.browserId === browserId
        : r.element.contains(document.activeElement),
    );
    await regions[(index + delta + regions.length) % regions.length].run();
  }
  return { focusPane, spatial, cycleTab, cycleRegion, content };
}
