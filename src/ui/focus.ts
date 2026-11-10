interface FocusLocation {
  element?: HTMLElement;
  filePath?: string;
  browserId?: string;
  tabId?: string;
  workspaceId?: string;
  paneId?: string;
  label?: string;
  focusKey?: string;
  editor?: boolean;
  input?: boolean;
  selectionStart?: number;
  selectionEnd?: number;
  scrollTop?: number;
  scrollLeft?: number;
}

export function createFocusManager(
  panes: HTMLElement,
  tree: HTMLElement,
  focusNative: (id: string) => void,
) {
  function focusLocation(
    element = document.activeElement as HTMLElement | null,
  ): FocusLocation {
    if (!element) return {};
    const file = element.closest<HTMLElement>("#project-panel [data-path]");
    if (file) return { element, filePath: file.dataset.path };
    const row = element.closest<HTMLElement>("[data-workspace-id]");
    if (row && !(element instanceof HTMLInputElement))
      return { element, workspaceId: row.dataset.workspaceId };
    const tab = element.closest<HTMLElement>("[data-tab-id]");
    if (tab) return { element, tabId: tab.dataset.tabId };
    const pane = element.closest<HTMLElement>("[data-pane-id]");
    const editor =
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLInputElement
        ? element
        : null;
    return {
      element,
      paneId: pane?.dataset.paneId,
      label: element.getAttribute("aria-label") ?? undefined,
      focusKey: element.dataset.focusKey,
      editor: element instanceof HTMLTextAreaElement,
      input: element instanceof HTMLInputElement,
      selectionStart: editor?.selectionStart ?? undefined,
      selectionEnd: editor?.selectionEnd ?? undefined,
      scrollTop: editor?.scrollTop,
      scrollLeft: editor?.scrollLeft,
    };
  }

  function restoreFocus(location: FocusLocation): void {
    if (location.browserId) {
      remembered = location;
      nativeOrigin = true;
      focusNative(location.browserId);
      return;
    }
    let target: HTMLElement | null =
      location.element?.isConnected && location.element.getClientRects().length
        ? location.element
        : null;
    if (target) {
      // Retained controls preserve exact identity, including nested split handles.
    } else if (location.filePath) {
      target =
        [
          ...document.querySelectorAll<HTMLElement>(
            "#project-panel [data-path]",
          ),
        ].find((row) => row.dataset.path === location.filePath) ?? null;
    } else if (location.tabId) {
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
      else if (location.input)
        target =
          [...(pane?.querySelectorAll<HTMLInputElement>("input") ?? [])].find(
            (element) => element.getAttribute("aria-label") === location.label,
          ) ?? null;
      else if (location.editor)
        target = pane?.querySelector<HTMLElement>("textarea") ?? null;
      else if (location.label) {
        target =
          [
            ...(pane?.querySelectorAll<HTMLElement>(
              "button[aria-label],input[aria-label],textarea[aria-label],[tabindex][aria-label]",
            ) ?? []),
          ].find(
            (element) => element.getAttribute("aria-label") === location.label,
          ) ?? null;
      }
    }
    if (
      !target &&
      !location.paneId &&
      !location.workspaceId &&
      !location.tabId &&
      location.label
    )
      target =
        [
          ...document.querySelectorAll<HTMLElement>(
            "button[aria-label],input[aria-label],textarea[aria-label],[tabindex][aria-label]",
          ),
        ].find(
          (element) => element.getAttribute("aria-label") === location.label,
        ) ?? null;
    target?.focus({ preventScroll: true });
    if (
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && target.selectionStart !== null)
    ) {
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
  let nativeOrigin = false;
  const remember = () => {
    if (!document.activeElement?.closest("dialog")) {
      nativeOrigin = false;
      remembered = focusLocation();
    }
  };
  const rememberBeforeLeaving = (event: FocusEvent) => {
    const element = event.target;
    if (
      !nativeOrigin &&
      element instanceof HTMLElement &&
      element !== document.body &&
      !element.closest("dialog")
    )
      remembered = focusLocation(element);
  };
  const capture = (): FocusLocation => {
    if (nativeOrigin) return remembered;
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
    native(id: string) {
      remembered = { browserId: id };
      nativeOrigin = true;
    },
    restore: restoreFocus,
    dispose() {
      document.removeEventListener("focusin", remember, true);
      document.removeEventListener("focusout", rememberBeforeLeaving, true);
      document.removeEventListener("close", restoreAfterClose, true);
    },
  };
}
