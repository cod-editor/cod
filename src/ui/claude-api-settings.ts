import type {
  ClaudeApiRequest,
  ClaudeApiStatus,
} from "../application/claude-api-settings";
import { actionRow, uiButton } from "../ui-kit";
import { formField } from "./form-field";

export function claudeApiSettingsEntry(): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-entry";
  const details = document.createElement("details");
  details.className = "claude-api-settings";
  const summary = document.createElement("summary");
  summary.textContent = "API authentication";
  const form = document.createElement("form");
  const endpoint = document.createElement("input");
  endpoint.type = "url";
  endpoint.required = true;
  endpoint.spellcheck = false;
  const token = document.createElement("input");
  token.type = "password";
  token.required = true;
  token.autocomplete = "new-password";
  token.spellcheck = false;
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.className = "settings-note";
  const save = uiButton("Save API authentication", "primary");
  save.type = "submit";
  const remove = uiButton("Remove saved authentication", "quiet");
  remove.type = "button";
  form.append(
    formField("API URL", endpoint),
    formField("API token", token),
    actionRow(remove, save),
  );
  form.hidden = true;
  details.append(summary, status, form);
  row.append(details);

  let current: ClaudeApiStatus | undefined;
  const display = (next: ClaudeApiStatus) => {
    current = next;
    form.hidden = next.kind === "unavailable";
    remove.hidden = next.kind !== "saved" && next.kind !== "locked";
    endpoint.value = next.kind === "saved" ? next.endpoint : "";
    token.placeholder = next.kind === "saved" ? "Saved token" : "";
    status.textContent =
      next.kind === "saved"
        ? "Saved for local Claude Code chats."
        : next.kind === "locked"
          ? "Allow Keychain access to unlock saved authentication."
          : next.kind === "unavailable"
            ? "Secure storage is unavailable on this device."
            : "Claude Code uses its native authentication.";
  };
  let busy = false;
  const perform = async (request: ClaudeApiRequest, control?: HTMLElement) => {
    if (busy) return;
    busy = true;
    const focused = document.activeElement === control;
    endpoint.disabled = token.disabled = save.disabled = remove.disabled = true;
    try {
      status.textContent =
        request.action === "status"
          ? "Checking saved authentication…"
          : request.action === "save"
            ? "Saving API authentication…"
            : "Removing saved authentication…";
      display(await window.cod.claudeApiSettings(request));
      if (request.action !== "status") token.value = "";
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      endpoint.disabled =
        token.disabled =
        save.disabled =
        remove.disabled =
          false;
      if (
        focused &&
        document.activeElement === document.body &&
        details.open &&
        details.isConnected
      )
        (control === remove && remove.hidden ? endpoint : control)?.focus();
    }
  };
  details.ontoggle = () => {
    if (details.open) {
      if (!current || current.kind === "locked")
        void perform({ action: "status" });
    } else {
      token.value = "";
    }
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (busy) return;
    void perform(
      { action: "save", endpoint: endpoint.value, token: token.value },
      document.activeElement === token ? token : save,
    );
  };
  remove.onclick = () => {
    token.value = "";
    void perform({ action: "remove" }, remove);
  };
  return row;
}
