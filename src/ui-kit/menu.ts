import { shortcutHint } from "./primitives";
import { icon } from "./icons";
let menuSequence = 0;
let currentMenu: HTMLDialogElement | undefined;
let releaseMenuTrigger: (() => void) | undefined;

export type MenuAction = {
  label: string;
  run: () => void;
  disabled?: boolean;
  title?: string;
  selected?: boolean;
  shortcut?: () => string;
  key?: "Enter" | "Space" | "Delete";
} | null;
export function menu(
  anchor: HTMLElement | { x: number; y: number },
  items: MenuAction[],
  options: {
    restoreFocus?: () => void;
    trigger?: HTMLButtonElement;
    shortcutChangeEvent?: string;
  } = {},
): void {
  releaseMenuTrigger?.();
  currentMenu?.close();
  currentMenu?.remove();
  const previous = document.activeElement as HTMLElement | null;
  let performed = false;
  const dialog = document.createElement("dialog");
  dialog.className = "context-menu";
  dialog.id = `context-menu-${++menuSequence}`;
  currentMenu = dialog;
  dialog.dataset.choices = String(
    items.some((item) => item?.selected !== undefined),
  );
  const trigger =
    options.trigger ??
    (anchor instanceof HTMLButtonElement ? anchor : undefined);
  const previousExpanded = trigger?.getAttribute("aria-expanded");
  const previousControls = trigger?.getAttribute("aria-controls");
  trigger?.classList.add("menu-open");
  trigger?.setAttribute("aria-expanded", "true");
  trigger?.setAttribute("aria-controls", dialog.id);
  const releaseTrigger = () => {
    if (trigger?.getAttribute("aria-controls") !== dialog.id) return;
    trigger.classList.remove("menu-open");
    if (previousExpanded === null) trigger.removeAttribute("aria-expanded");
    else if (previousExpanded !== undefined)
      trigger.setAttribute("aria-expanded", previousExpanded);
    if (previousControls === null) trigger.removeAttribute("aria-controls");
    else if (previousControls !== undefined)
      trigger.setAttribute("aria-controls", previousControls);
  };
  releaseMenuTrigger = releaseTrigger;
  dialog.setAttribute("aria-label", "Actions");
  const hints: Array<() => void> = [];
  const events = new AbortController();
  for (const item of items) {
    if (!item) {
      dialog.append(document.createElement("hr"));
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    const label = document.createElement("span");
    label.className = "menu-label";
    label.textContent = item.label;
    button.append(label);
    button.setAttribute("aria-label", item.label);
    if (item.shortcut || item.key) {
      const hint = shortcutHint();
      hint.classList.add("menu-shortcut");
      const update = () => {
        const shortcut = item.shortcut?.() ?? "";
        hint.textContent = item.disabled ? "" : shortcut || item.key || "";
      };
      update();
      if (item.shortcut) hints.push(update);
      button.append(hint);
    }
    if (item.selected !== undefined) {
      button.setAttribute("aria-pressed", String(item.selected));
      button.classList.add("choice-row");
      const check = icon("check");
      check.classList.add("choice-check");
      button.prepend(check);
    }
    button.disabled = !!item.disabled;
    if (item.title) button.title = item.title;
    button.onpointermove = () => button.focus({ preventScroll: true });
    button.onclick = () => {
      performed = true;
      dialog.close();
      item.run();
    };
    dialog.append(button);
  }
  const place = () => {
    const rect =
      anchor instanceof HTMLElement
        ? anchor.getBoundingClientRect()
        : undefined;
    const x = rect ? rect.left : (anchor as { x: number; y: number }).x,
      y = rect ? rect.bottom : (anchor as { x: number; y: number }).y;
    dialog.style.left = `${Math.max(4, Math.min(x, innerWidth - dialog.offsetWidth - 4))}px`;
    const top =
      y + dialog.offsetHeight > innerHeight - 4 && rect
        ? rect.top - dialog.offsetHeight
        : y;
    dialog.style.top = `${Math.max(4, Math.min(top, innerHeight - dialog.offsetHeight - 4))}px`;
  };
  document.body.append(dialog);
  dialog.showModal();
  place();
  if (hints.length && options.shortcutChangeEvent)
    document.addEventListener(
      options.shortcutChangeEvent,
      () => {
        if (!dialog.open) return;
        for (const update of hints) update();
        place();
      },
      { signal: events.signal },
    );
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        dialog.close();
    }
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dialog.close();
    if (currentMenu === dialog) {
      if (options.restoreFocus) options.restoreFocus();
      else if (previous?.isConnected) previous.focus({ preventScroll: true });
    }
  });
  dialog.onclose = () => {
    events.abort();
    const isCurrent = currentMenu === dialog;
    if (isCurrent) {
      currentMenu = undefined;
      releaseMenuTrigger = undefined;
    }
    releaseTrigger();
    const restoreFocus =
      dialog.contains(document.activeElement) ||
      document.activeElement === document.body;
    dialog.remove();
    // A native close event may arrive after a newer click or focus command.
    // Restore abandoned menu focus without taking it from the new target.
    if (isCurrent && !performed && restoreFocus) {
      if (options.restoreFocus) options.restoreFocus();
      else if (previous?.isConnected) previous.focus({ preventScroll: true });
    }
  };
  dialog.onkeydown = (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [
      ...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length
    ]?.focus();
  };
  (
    dialog.querySelector<HTMLButtonElement>(
      'button[aria-pressed="true"]:not(:disabled)',
    ) ?? dialog.querySelector<HTMLButtonElement>("button:not(:disabled)")
  )?.focus();
}
