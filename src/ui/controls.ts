import {
  menu as openMenu,
  type MenuAction as SharedMenuAction,
} from "../ui-kit";
import {
  formatShortcut,
  type CommandId,
  type KeyboardSurface,
} from "../keyboard";
import { keyboardPlatform } from "./keyboard-ui";

export type MenuAction =
  | (Omit<Exclude<SharedMenuAction, null>, "shortcut"> & {
      command?: CommandId;
      surface?: KeyboardSurface;
    })
  | null;

let nativeMenuOpening = 0;
let releaseNativeMenuTrigger: (() => void) | undefined;

export function menu(
  anchor: HTMLElement | { x: number; y: number },
  items: MenuAction[],
  options: {
    restoreFocus?: () => void;
    trigger?: HTMLButtonElement;
    showCommands?: boolean;
    origin?: HTMLElement;
  } = {},
) {
  const showCommands = options.showCommands !== false;
  const actions = items.map((item) => {
    if (!item) return null;
    const { command, surface = "shell", ...action } = item;
    return {
      ...action,
      shortcut: command
        ? () =>
            showCommands
              ? formatShortcut(command, keyboardPlatform, surface)
              : ""
        : undefined,
    };
  });
  // The shell and live browser are siblings. Use the operating system popup
  // when this menu might cover a native pane.
  if (
    !document.querySelector("dialog:modal") &&
    [...document.querySelectorAll(".browser-content")].some(
      (slot) => slot.getClientRects().length,
    )
  ) {
    releaseNativeMenuTrigger?.();
    const opening = ++nativeMenuOpening;
    const previous = document.activeElement;
    const origin =
      options.origin ?? (anchor instanceof HTMLElement ? anchor : undefined);
    const trigger =
      options.trigger ??
      (anchor instanceof HTMLButtonElement ? anchor : undefined);
    const wasExpanded = trigger?.getAttribute("aria-expanded");
    trigger?.classList.add("menu-open");
    trigger?.setAttribute("aria-expanded", "true");
    const releaseTrigger = () => {
      trigger?.classList.remove("menu-open");
      if (wasExpanded == null) trigger?.removeAttribute("aria-expanded");
      else trigger?.setAttribute("aria-expanded", wasExpanded);
      releaseNativeMenuTrigger = undefined;
    };
    releaseNativeMenuTrigger = releaseTrigger;
    const rectangle =
      anchor instanceof HTMLElement
        ? anchor.getBoundingClientRect()
        : undefined;
    const point = rectangle
      ? { x: rectangle.left, y: rectangle.bottom }
      : (anchor as { x: number; y: number });
    void window.cod
      .shellMenu(
        point,
        actions.map(
          (action) =>
            action && {
              label: action.label,
              disabled: !!action.disabled,
              selected: action.selected,
              shortcut: action.disabled
                ? ""
                : (action.shortcut?.() ?? action.key ?? ""),
              title: action.title,
            },
        ),
      )
      .then(
        (index) => {
          if (
            opening !== nativeMenuOpening ||
            (origin && !origin.isConnected) ||
            document.querySelector("dialog:modal")
          )
            return;
          if (index !== null) actions[index]?.run();
          else if (options.restoreFocus) options.restoreFocus();
          else if (
            previous instanceof HTMLElement &&
            previous.isConnected &&
            (document.activeElement === previous ||
              document.activeElement === document.body)
          )
            previous.focus({ preventScroll: true });
        },
        () => undefined,
      )
      .finally(() => {
        if (releaseNativeMenuTrigger === releaseTrigger) releaseTrigger();
      });
    return;
  }
  openMenu(anchor, actions, {
    restoreFocus: options.restoreFocus,
    trigger: options.trigger,
    shortcutChangeEvent: showCommands ? "cod:keymap-changed" : undefined,
  });
}
