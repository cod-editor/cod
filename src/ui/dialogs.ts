import {
  uiButton,
  dialogRegions,
  dialogSurface,
  keyHintButton,
} from "../ui-kit";
let formSequence = 0;
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
  const dialog = dialogSurface(options.title);
  dialog.setAttribute("aria-label", options.title);
  const { body, actions } = dialogRegions(dialog, options.title);
  const form = document.createElement("form");
  form.id = `input-dialog-form-${++formSequence}`;
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
  const restore = () => {
    if (!previous?.isConnected || document.querySelector("dialog[open]"))
      return;
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
  };
  let closing = false;
  const close = () => {
    closing = true;
    dialog.close();
    restore();
  };
  dialog.oncancel = (event) => {
    event.preventDefault();
    close();
  };
  const cancel = keyHintButton(
    actionButton("Cancel", async () => close()),
    "Esc",
  );
  cancel.classList.add("quiet");
  const submit = keyHintButton(
    uiButton(options.submitLabel, "primary"),
    "Enter",
  );
  submit.type = "submit";
  submit.setAttribute("form", form.id);
  actions.append(cancel, submit);
  form.append(label, error);
  body.append(form);
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
    const abandoned =
      dialog.contains(document.activeElement) ||
      document.activeElement === document.body;
    dialog.remove();
    if (!closing && !completed && abandoned) restore();
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
  ariaLabel = title,
  cancelLabel = "Cancel",
): HTMLDialogElement {
  const dialog = dialogSurface(ariaLabel);
  const { body, actions } = dialogRegions(dialog, title);
  const description = document.createElement("p");
  description.textContent = text;
  const cancel = keyHintButton(
    actionButton(cancelLabel, async () => dialog.close()),
    "Esc",
  );
  const accept = actionButton(label, async () => {
    await action();
    dialog.close();
  });
  cancel.classList.add("quiet");
  accept.classList.add("primary");
  actions.append(cancel, accept);
  body.append(description);
  document.body.append(dialog);
  dialog.onclose = () => dialog.remove();
  dialog.showModal();
  cancel.focus();
  return dialog;
}
