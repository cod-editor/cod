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

export async function remoteWorkspaceDialog(
  invoke: Invoke,
  afterConnect: (reviewAccess: boolean, selectedKey: boolean) => void,
): Promise<void> {
  const previous = document.activeElement;
  const remembered = await invoke<WorkspaceHostTarget | null>(
    "remote.target",
    {},
    { reportError: false },
  ).catch(() => null);
  const dialog = dialogSurface("Connect to Linux workspace");
  const { body, actions } = dialogRegions(dialog, "Connect to Linux workspace");
  const form = document.createElement("form");
  form.id = "connect-linux-workspace";
  const alias = document.createElement("input");
  alias.required = true;
  alias.autocomplete = "off";
  alias.value = remembered?.alias ?? "";
  const socket = document.createElement("input");
  socket.required = true;
  socket.autocomplete = "off";
  socket.value = remembered?.socketPath ?? "";
  const publicKey = document.createElement("input");
  publicKey.autocomplete = "off";
  publicKey.value = remembered?.publicKey ?? "";
  form.append(
    formField("SSH host alias", alias),
    formField("Linux socket path", socket),
    formField("SSH public key for private review (optional)", publicKey),
  );
  body.append(form);

  let connecting = false;
  const cancel = () => {
    if (connecting) void invoke("remote.cancel", {}, { reportError: false });
    dialog.close();
  };
  dialog.oncancel = (event) => {
    event.preventDefault();
    cancel();
  };
  const cancelButton = keyHintButton(
    actionButton("Cancel", async () => cancel()),
    "Esc",
  );
  const connect = keyHintButton(uiButton("Connect", "primary"), "Enter");
  connect.type = "submit";
  connect.setAttribute("form", form.id);
  actions.append(cancelButton, connect);
  dialog.onclose = () => {
    dialog.remove();
    if (previous instanceof HTMLElement && previous.isConnected)
      previous.focus({ preventScroll: true });
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (connecting) return;
    connecting = true;
    connect.disabled = true;
    connect.setAttribute("aria-busy", "true");
    dialog.querySelector(".action-error")?.remove();
    try {
      const target = {
        alias: alias.value.trim(),
        socketPath: socket.value.trim(),
        publicKey: publicKey.value.trim(),
      };
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
      connecting = false;
      connect.disabled = false;
      connect.removeAttribute("aria-busy");
    }
  };
  document.body.append(dialog);
  dialog.showModal();
  alias.focus();
}
