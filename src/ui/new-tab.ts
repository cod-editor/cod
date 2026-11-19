import { actionButton } from "./action-feedback";
import { icon } from "./controls";

export function newTab(actions: {
  file: () => Promise<void>;
  browser: () => void;
  chat: () => Promise<unknown>;
  terminal: () => void;
}): HTMLElement {
  const host = document.createElement("div");
  host.className = "pane-body new-tab";
  host.setAttribute("role", "region");
  host.setAttribute("aria-label", "New tab");
  const choices = document.createElement("div");
  choices.className = "new-tab-choices";
  for (const [name, label, kind] of [
    ["file", "New file", "file"],
    ["browser", "Browser", "browser"],
    ["chat", "Chat", "conversation"],
    ["terminal", "Terminal", "terminal"],
  ] as const) {
    const button = actionButton(
      label,
      async () => {
        await actions[name]();
      },
      icon(kind),
    );
    choices.append(button);
  }
  choices.onkeydown = (event) => {
    if (
      ![
        "ArrowDown",
        "ArrowUp",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
      ].includes(event.key) ||
      event.isComposing
    )
      return;
    event.preventDefault();
    const buttons = [...choices.querySelectorAll<HTMLButtonElement>("button")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index +
              (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) +
              buttons.length) %
            buttons.length
    ]?.focus();
  };
  host.append(choices);
  return host;
}
