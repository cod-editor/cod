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

export function menu(
  anchor: HTMLElement | { x: number; y: number },
  items: MenuAction[],
  options: {
    restoreFocus?: () => void;
    trigger?: HTMLButtonElement;
    showCommands?: boolean;
  } = {},
) {
  const showCommands = options.showCommands !== false;
  openMenu(
    anchor,
    items.map((item) => {
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
    }),
    {
      restoreFocus: options.restoreFocus,
      trigger: options.trigger,
      shortcutChangeEvent: showCommands ? "cod:keymap-changed" : undefined,
    },
  );
}
