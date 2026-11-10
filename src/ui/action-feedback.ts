export function actionButton(
  label: string,
  action: () => Promise<unknown>,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.focusKey = JSON.stringify(["pane-action", label]);
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    const surface = button.closest("dialog, [data-pane-id]");
    surface?.querySelector(".action-error")?.remove();
    try {
      await action();
    } catch (error) {
      showActionError(error, surface);
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  };
  return button;
}
export function showActionError(error: unknown, surface: Element | null): void {
  if (!surface?.isConnected) return;
  let message = surface.querySelector<HTMLElement>(".action-error");
  if (!message) {
    message = document.createElement("div");
    message.className = "action-error";
    message.setAttribute("role", "alert");
    const composer = surface.querySelector(".composer");
    if (composer) composer.before(message);
    else surface.append(message);
  }
  message.textContent = error instanceof Error ? error.message : String(error);
}
