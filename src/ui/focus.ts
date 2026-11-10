interface FocusLocation {
  tabId?: string;
  workspaceId?: string;
  paneId?: string;
  label?: string;
  focusKey?: string;
  editor?: boolean;
  selectionStart?: number;
  selectionEnd?: number;
  scrollTop?: number;
  scrollLeft?: number;
}

export function createFocusManager(panes: HTMLElement, tree: HTMLElement) {
  function focusLocation(
    element = document.activeElement as HTMLElement | null,
  ): FocusLocation {
    if (!element) return {};
    const row = element.closest<HTMLElement>("[data-workspace-id]");
    if (row) return { workspaceId: row.dataset.workspaceId };
    const tab = element.closest<HTMLElement>("[data-tab-id]");
    if (tab) return { tabId: tab.dataset.tabId };
    const pane = element.closest<HTMLElement>("[data-pane-id]");
    const editor =
      element.tagName === "TEXTAREA" ? (element as HTMLTextAreaElement) : null;
    return {
      paneId: pane?.dataset.paneId,
      label: element.getAttribute("aria-label") ?? undefined,
      focusKey: element.dataset.focusKey,
      editor: editor !== null,
      selectionStart: editor?.selectionStart,
      selectionEnd: editor?.selectionEnd,
      scrollTop: editor?.scrollTop,
      scrollLeft: editor?.scrollLeft,
    };
  }

  function restoreFocus(location: FocusLocation): void {
    let target: HTMLElement | null = null;
    if (location.tabId) {
      target =
        [...panes.querySelectorAll<HTMLElement>("[data-tab-id]")].find(
          (element) => element.dataset.tabId === location.tabId,
        ) ?? null;
    } else if (location.workspaceId) {
      target =
        [...tree.querySelectorAll<HTMLElement>("[data-workspace-id]")].find(
          (row) => row.dataset.workspaceId === location.workspaceId,
        ) ?? null;
    } else if (location.paneId) {
      const pane = [
        ...panes.querySelectorAll<HTMLElement>("[data-pane-id]"),
      ].find((item) => item.dataset.paneId === location.paneId);
      if (location.focusKey)
        target =
          [
            ...(pane?.querySelectorAll<HTMLElement>("[data-focus-key]") ?? []),
          ].find((element) => element.dataset.focusKey === location.focusKey) ??
          null;
      else if (location.editor)
        target = pane?.querySelector<HTMLElement>("textarea") ?? null;
      else if (location.label) {
        target =
          [...(pane?.querySelectorAll<HTMLElement>("[aria-label]") ?? [])].find(
            (element) => element.getAttribute("aria-label") === location.label,
          ) ?? null;
      }
    }
    if (
      !location.paneId &&
      !location.workspaceId &&
      !location.tabId &&
      location.label
    )
      target =
        [...document.querySelectorAll<HTMLElement>("button[aria-label]")].find(
          (element) => element.getAttribute("aria-label") === location.label,
        ) ?? null;
    target?.focus({ preventScroll: true });
    if (target instanceof HTMLTextAreaElement) {
      target.setSelectionRange(
        location.selectionStart ?? 0,
        location.selectionEnd ?? 0,
      );
      target.scrollTop = location.scrollTop ?? 0;
      target.scrollLeft = location.scrollLeft ?? 0;
    }
    if (target) remembered = focusLocation(target);
  }

  let remembered: FocusLocation = {};
  const remember = () => {
    if (!document.activeElement?.closest("dialog"))
      remembered = focusLocation();
  };
  const rememberBeforeLeaving = (event: FocusEvent) => {
    const element = event.target;
    if (
      element instanceof HTMLElement &&
      element !== document.body &&
      !element.closest("dialog")
    )
      remembered = focusLocation(element);
  };
  const capture = (): FocusLocation => {
    const location = focusLocation();
    if (
      document.activeElement !== document.body &&
      !document.activeElement?.closest("dialog")
    )
      remembered = location;
    return location;
  };
  const restoreAfterClose = () =>
    requestAnimationFrame(() => {
      if (
        !document.querySelector("dialog[open]") &&
        (!document.activeElement || document.activeElement === document.body)
      )
        restoreFocus(remembered);
    });
  document.addEventListener("focusin", remember, true);
  document.addEventListener("focusout", rememberBeforeLeaving, true);
  document.addEventListener("close", restoreAfterClose, true);
  return {
    capture,
    restore: restoreFocus,
    dispose() {
      document.removeEventListener("focusin", remember, true);
      document.removeEventListener("focusout", rememberBeforeLeaving, true);
      document.removeEventListener("close", restoreAfterClose, true);
    },
  };
}
