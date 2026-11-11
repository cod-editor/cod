import {
  sitePermissionNames,
  type SitePolicy,
  type SiteRequest,
} from "../browser/permission-types";
import type { Invoke } from "./contracts";
import { actionButton, showActionError } from "./action-feedback";
export function updateSiteRequests(
  host: HTMLElement,
  requests: SiteRequest[],
  invoke: Invoke,
) {
  const key = JSON.stringify(requests);
  if (host.dataset.requests === key) return;
  host.dataset.requests = key;
  host.replaceChildren();
  host.hidden = !requests.length;
  for (const request of requests) {
    const row = document.createElement("section");
    row.setAttribute("role", "region");
    row.setAttribute("aria-label", "Site permission request");
    const message = document.createElement("p");
    message.textContent = `${request.origin} wants to use ${request.permissions.map((key) => sitePermissionNames[key].toLowerCase()).join(" and ")}${request.topOrigin !== request.origin ? ` inside ${request.topOrigin}` : ""}.`;
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    for (const [decision, label] of [
      ["allow-once", "Allow once"],
      ["allow", "Always allow"],
      ["block", "Block"],
    ])
      actions.append(
        actionButton(label, () =>
          invoke("browser.permission-answer", {
            requestId: request.id,
            decision,
          }),
        ),
      );
    row.append(message, actions);
    host.append(row);
  }
}
export async function sitePermissions(invoke: Invoke, url?: string) {
  const policies = await invoke<SitePolicy[]>("browser.permissions", {});
  const dialog = document.createElement("dialog");
  dialog.className = "picker site-permissions";
  dialog.setAttribute("aria-label", "Site permissions");
  const title = document.createElement("h2");
  title.textContent = "Site permissions";
  dialog.append(title);
  let currentOrigin: string | undefined;
  try {
    const parsed = new URL(url ?? "");
    if (/^https?:$/.test(parsed.protocol)) currentOrigin = parsed.origin;
  } catch {}
  const pairs = new Map<string, { origin: string; topOrigin: string }>();
  if (currentOrigin)
    pairs.set(JSON.stringify([currentOrigin, currentOrigin]), {
      origin: currentOrigin,
      topOrigin: currentOrigin,
    });
  for (const policy of policies)
    if (!currentOrigin || policy.topOrigin === currentOrigin)
      pairs.set(JSON.stringify([policy.origin, policy.topOrigin]), policy);
  for (const { origin, topOrigin } of pairs.values()) {
    const heading = document.createElement("h3");
    heading.textContent =
      origin === topOrigin ? origin : `${origin} inside ${topOrigin}`;
    dialog.append(heading);
    for (const [permission, name] of Object.entries(sitePermissionNames)) {
      const label = document.createElement("label");
      label.className = "setting-row";
      label.textContent = name;
      const select = document.createElement("select");
      select.setAttribute("aria-label", `${name} for ${origin}`);
      select.append(
        new Option("Ask", "ask"),
        new Option("Allow", "allow"),
        new Option("Block", "block"),
      );
      select.value =
        policies.find(
          (item) =>
            item.origin === origin &&
            item.topOrigin === topOrigin &&
            item.permission === permission,
        )?.decision ?? "ask";
      select.onchange = () => {
        void invoke(
          "browser.permission-set",
          { origin, topOrigin, permission, decision: select.value },
          { reportError: false },
        ).catch((error) => showActionError(error, dialog));
      };
      label.append(select);
      dialog.append(label);
    }
  }
  const note = document.createElement("p");
  note.textContent = pairs.size
    ? "Changes apply to new requests. Reload the page to apply them to an active session."
    : "No saved site permissions.";
  dialog.append(
    note,
    actionButton("Done", async () => dialog.close()),
  );
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}
