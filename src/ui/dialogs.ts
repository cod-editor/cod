import { formField } from "./form-field";
import { actionButton } from "./action-feedback";
interface InputDialog {
  title: string;
  label: string;
  value?: string;
  submitLabel: string;
  type?: "text" | "number";
  min?: number;
  max?: number;
  required?: boolean;
  submit: (value: string) => Promise<unknown>;
  completed?: () => void;
}
export function inputDialog(options: InputDialog): void {
  const previous = document.activeElement as HTMLElement | null;
  const selection =
    previous instanceof HTMLTextAreaElement ||
    previous instanceof HTMLInputElement
      ? {
          start: previous.selectionStart,
          end: previous.selectionEnd,
          direction: previous.selectionDirection,
          top: previous.scrollTop,
          left: previous.scrollLeft,
        }
      : undefined;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", options.title);
  const title = document.createElement("h2");
  title.textContent = options.title;
  const form = document.createElement("form");
  const input = document.createElement("input");
  input.setAttribute("aria-label", options.label);
  input.type = options.type ?? "text";
  input.value = options.value ?? "";
  input.required = options.required !== false;
  input.autocomplete = "off";
  if (options.min !== undefined) input.min = String(options.min);
  if (options.max !== undefined) input.max = String(options.max);
  const label = formField(options.label, input);
  const error = document.createElement("div");
  error.className = "dialog-error";
  error.setAttribute("role", "alert");
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = actionButton("Cancel", async () => dialog.close());
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary";
  submit.textContent = options.submitLabel;
  actions.append(cancel, submit);
  form.append(label, error, actions);
  dialog.append(title, form);
  document.body.append(dialog);
  let completed = false,
    busy = false;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    submit.disabled = true;
    submit.setAttribute("aria-busy", "true");
    error.textContent = "";
    try {
      await options.submit(input.value);
      completed = true;
      dialog.close();
      options.completed?.();
    } catch (cause) {
      error.textContent =
        cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
    }
  };
  dialog.onclose = () => {
    dialog.remove();
    if (
      !completed &&
      previous?.isConnected &&
      !document.querySelector("dialog[open]")
    ) {
      previous.focus({ preventScroll: true });
      if (
        selection &&
        (previous instanceof HTMLTextAreaElement ||
          previous instanceof HTMLInputElement)
      ) {
        if (selection.start !== null && selection.end !== null)
          previous.setSelectionRange(
            selection.start,
            selection.end,
            selection.direction ?? undefined,
          );
        previous.scrollTop = selection.top;
        previous.scrollLeft = selection.left;
      }
    }
  };
  dialog.showModal();
  input.focus();
  input.select();
}
export function confirmAction(
  title: string,
  text: string,
  label: string,
  action: () => Promise<unknown>,
): void {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", title);
  const heading = document.createElement("h2");
  heading.textContent = title;
  const body = document.createElement("p");
  body.textContent = text;
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = actionButton("Cancel", async () => dialog.close());
  const accept = actionButton(label, async () => {
    await action();
    dialog.close();
  });
  actions.append(cancel, accept);
  dialog.append(heading, body, actions);
  document.body.append(dialog);
  dialog.onclose = () => dialog.remove();
  dialog.showModal();
  cancel.focus();
}
