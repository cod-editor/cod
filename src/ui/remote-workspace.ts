import { actionButton, showActionError } from "./action-feedback";
import type { Invoke } from "./contracts";
import { formField } from "./form-field";
import type { WorkspaceHostTarget } from "../remote-workspace/protocol";
import {
  dialogRegions,
  dialogSurface,
  keyHintButton,
  uiButton,
} from "./primitives";

export function remoteWorkspaceDialog(
  invoke: Invoke,
  restoreFocus: () => void,
  afterConnect: (reviewAccess: boolean, selectedKey: boolean) => void,
): void {
  const dialog = dialogSurface("Connect to Linux workspace");
  dialog.dataset.browserBackdrop = "connection";
  const { body, actions } = dialogRegions(dialog, "Connect to Linux workspace");
  const form = document.createElement("form");
  form.id = "connect-linux-workspace";
  const alias = document.createElement("input");
  alias.required = true;
  alias.autocomplete = "off";
  const socket = document.createElement("input");
  socket.required = true;
  socket.autocomplete = "off";
  const publicKey = document.createElement("input");
  publicKey.autocomplete = "off";
  form.append(
    formField("SSH host alias", alias),
    formField("Linux socket path", socket),
    formField("SSH public key for private review (optional)", publicKey),
  );
  body.append(form);

  // Show the dialog in the same turn as Commands closes so it keeps the frame.
  const initialized = invoke<WorkspaceHostTarget | null>(
    "remote.target",
    {},
    { reportError: false },
  )
    .catch(() => null)
    .then((target) => {
      if (!dialog.open || !target) return;
      alias.defaultValue = target.alias;
      socket.defaultValue = target.socketPath;
      publicKey.defaultValue = target.publicKey ?? "";
    });
  let connecting = false;
  let connectingToHost = false;
  const cancel = () => {
    if (connectingToHost)
      void invoke("remote.cancel", {}, { reportError: false });
    dialog.close();
    restoreFocus();
  };
  dialog.oncancel = (event) => {
    event.preventDefault();
    cancel();
  };
  const cancelButton = keyHintButton(
    actionButton("Cancel", async () => cancel()),
    "Esc",
  );
  cancelButton.classList.add("quiet");
  const connect = keyHintButton(uiButton("Connect", "primary"), "Enter");
  connect.type = "submit";
  connect.setAttribute("form", form.id);
  actions.append(cancelButton, connect);
  dialog.onclose = () => dialog.remove();
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (connecting) return;
    connecting = true;
    connect.disabled = true;
    connect.setAttribute("aria-busy", "true");
    dialog.querySelector(".action-error")?.remove();
    try {
      await initialized;
      if (!dialog.open) return;
      const target = {
        alias: alias.value.trim(),
        socketPath: socket.value.trim(),
        publicKey: publicKey.value.trim(),
      };
      connectingToHost = true;
      const reviewAccess = await invoke<boolean>("remote.connect", target, {
        reportError: false,
      });
      if (dialog.open) {
        dialog.close();
        afterConnect(reviewAccess, target.publicKey !== "");
      }
    } catch (error) {
      if (dialog.open) showActionError(error, dialog);
    } finally {
      connectingToHost = false;
      connecting = false;
      connect.disabled = false;
      connect.removeAttribute("aria-busy");
    }
  };
  document.body.append(dialog);
  dialog.showModal();
  alias.focus();
}
