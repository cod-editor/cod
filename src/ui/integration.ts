import { formField } from "./form-field";
import { readPreference, writePreference } from "./preferences";
import type { Invoke } from "./contracts";
interface Preview {
  provider: string;
  profilePath: string;
  changes: Array<{ path: string; before: string | null; after: string }>;
  trustInstructions: string;
  previewHash: string;
  installed: boolean;
  backups?: string[];
}
export interface IntegrationProfile {
  provider: string;
  profilePath: string;
  exists: boolean;
  installed: boolean;
  error?: string;
}
export function createIntegrationSetup(invoke: Invoke, invalidate: () => void) {
  let profiles: IntegrationProfile[] = [];
  const declined = new Set(
    readPreference<string[]>("integration-declined", []),
  );
  const key = (profile: IntegrationProfile) =>
    `${profile.provider}:${profile.profilePath}`;
  const refresh = () =>
    invoke<IntegrationProfile[]>(
      "agent-integration.profiles",
      {},
      { reportError: false },
    )
      .then((value) => {
        profiles = value;
        invalidate();
      })
      .catch(() => undefined);
  void refresh();
  function open(provider = "codex") {
    integrationDialog(
      invoke,
      profiles.find((p) => p.provider === provider),
      () => {
        void refresh();
      },
    );
  }
  function offer(provider: string): HTMLElement | undefined {
    const profile = profiles.find((p) => p.provider === provider);
    if (!profile || profile.installed || declined.has(key(profile))) return;
    const host = document.createElement("section");
    host.className = "integration-offer";
    host.dataset.focusKey = key(profile);
    host.setAttribute("aria-label", "Agent setup");
    const title = document.createElement("strong");
    title.textContent = `Connect ${provider === "codex" ? "Codex" : provider === "kimi" ? "Kimi" : "Claude Code"} to Cod`;
    const text = document.createElement("p");
    text.textContent =
      "Add Cod's workspace commands and status hooks to your agent profile.";
    const actions = document.createElement("div");
    actions.className = "setup-actions";
    const setup = document.createElement("button");
    setup.type = "button";
    setup.textContent = "Set up integration";
    setup.className = "primary";
    setup.onclick = () => open(provider);
    const skip = document.createElement("button");
    skip.type = "button";
    skip.textContent = "Not now";
    skip.onclick = () => {
      declined.add(key(profile));
      writePreference("integration-declined", [...declined]);
      invalidate();
    };
    actions.append(setup, skip);
    host.append(title, text, actions);
    return host;
  }
  return { open, offer };
}
export function integrationDialog(
  invoke: Invoke,
  initial?: IntegrationProfile,
  installed?: () => void,
): void {
  const dialog = document.createElement("dialog");
  dialog.className = "integration-dialog";
  dialog.setAttribute("aria-label", "Install agent integration");
  const title = document.createElement("h2");
  title.textContent = "Agent integration";
  const form = document.createElement("form");
  const provider = document.createElement("select");
  provider.setAttribute("aria-label", "Provider");
  provider.append(
    new Option("Codex", "codex"),
    new Option("Claude Code", "claude"),
    new Option("Kimi", "kimi"),
  );
  provider.value = initial?.provider ?? "codex";
  const path = document.createElement("input");
  path.setAttribute("aria-label", "Agent profile directory");
  path.required = true;
  path.value = initial?.profilePath ?? "";
  path.placeholder = "Absolute path to the agent profile";
  const label = formField("Agent profile directory", path);
  const status = document.createElement("div");
  status.className = "integration-status";
  status.setAttribute("role", "status");
  const previewHost = document.createElement("div");
  previewHost.className = "integration-preview";
  const trust = document.createElement("p");
  trust.className = "integration-trust";
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.onclick = () => dialog.close();
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Preview changes";
  submit.className = "primary";
  actions.append(cancel, submit);
  form.append(
    formField("Provider", provider),
    label,
    status,
    previewHost,
    trust,
    actions,
  );
  dialog.append(title, form);
  document.body.append(dialog);
  dialog.onclose = () => dialog.remove();
  let preview: Preview | undefined,
    generation = 0,
    busy = false;
  const reset = () => {
    preview = undefined;
    generation++;
    previewHost.replaceChildren();
    status.textContent = "";
    trust.textContent = "";
    submit.textContent = "Preview changes";
    submit.hidden = false;
    cancel.textContent = "Cancel";
  };
  path.oninput = reset;
  provider.onchange = () => {
    reset();
    const current = generation;
    status.textContent = "Reading profiles...";
    void invoke<IntegrationProfile[]>(
      "agent-integration.profiles",
      {},
      { reportError: false },
    )
      .then((profiles) => {
        if (current !== generation) return;
        path.value =
          profiles.find((p) => p.provider === provider.value)?.profilePath ??
          "";
        status.textContent = "";
      })
      .catch((error) => {
        status.textContent =
          error instanceof Error ? error.message : String(error);
      });
  };
  if (!initial) provider.onchange(new Event("change"));
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    submit.disabled = true;
    submit.setAttribute("aria-busy", "true");
    provider.disabled = true;
    path.disabled = true;
    const current = generation;
    try {
      if (preview && !preview.installed) {
        status.textContent = "Installing integration...";
        const result = await invoke<Preview>(
          "agent-integration.install",
          {
            provider: preview.provider,
            profilePath: preview.profilePath,
            expectedPreviewHash: preview.previewHash,
          },
          { reportError: false },
        );
        preview = result;
        status.textContent = "Integration installed.";
        previewHost.replaceChildren();
        trust.textContent = result.trustInstructions;
        submit.hidden = true;
        cancel.textContent = "Done";
        installed?.();
      } else {
        status.textContent = "Reading profile...";
        previewHost.replaceChildren();
        const result = await invoke<Preview>(
          "agent-integration.inspect",
          { provider: provider.value, profilePath: path.value },
          { reportError: false },
        );
        if (current !== generation) return;
        preview = result;
        status.textContent = result.installed
          ? "Integration is installed."
          : `${result.changes.length} files will be updated.`;
        const description = document.createElement("p");
        description.className = "integration-summary";
        description.textContent =
          "Adds Cod's workspace skill and task-status hooks to this provider profile. Existing unrelated settings are preserved.";
        previewHost.append(description);
        const changes = document.createElement("details");
        changes.className = "integration-changes";
        const changesTitle = document.createElement("summary");
        changesTitle.textContent = `Review ${result.changes.length} file changes`;
        changes.append(changesTitle);
        for (const change of result.changes) {
          const details = document.createElement("details"),
            summary = document.createElement("summary"),
            code = document.createElement("pre");
          summary.textContent = `${change.before === null ? "Create" : "Update"} ${change.path.startsWith(result.profilePath + "/") ? change.path.slice(result.profilePath.length + 1) : change.path}`;
          summary.title = change.path;
          code.textContent = change.after;
          const caption = document.createElement("div");
          caption.className = "change-caption";
          caption.textContent = "Proposed contents";
          details.append(summary, caption, code);
          if (change.before !== null) {
            const before = document.createElement("details");
            const beforeTitle = document.createElement("summary");
            beforeTitle.textContent = "Current contents";
            const beforeCode = document.createElement("pre");
            beforeCode.textContent = change.before;
            before.append(beforeTitle, beforeCode);
            details.append(before);
          }
          changes.append(details);
        }
        previewHost.append(changes);
        trust.textContent = result.trustInstructions;
        submit.textContent = "Install integration";
        submit.hidden = result.installed;
        cancel.textContent = result.installed ? "Done" : "Cancel";
      }
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
      provider.disabled = false;
      path.disabled = false;
    }
  };
  dialog.showModal();
  path.focus();
}
