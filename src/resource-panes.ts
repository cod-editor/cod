import type { DiffPane, PreviewPane, WorkspaceState } from "./types";
import type { Invoke } from "./ui/contracts";
export function previewPane(
  workspace: WorkspaceState,
  pane: PreviewPane,
  invoke: Invoke,
): HTMLElement {
  const region = document.createElement("div");
  region.className = "pane-body markdown-preview";
  region.setAttribute("role", "region");
  region.setAttribute("aria-label", "Markdown preview");
  const frame = document.createElement("iframe");
  frame.title = "Markdown preview";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.src = "cod-preview://preview/preview.html";
  const message = document.createElement("div");
  message.setAttribute("role", "status");
  region.append(frame, message);
  frame.addEventListener("load", () => {
    void invoke<{ content: string }>("preview.read", {
      workspace: workspace.id,
      id: pane.id,
    })
      .then((result) =>
        frame.contentWindow?.postMessage(
          { type: "cod-preview", content: result.content },
          "*",
        ),
      )
      .catch((error) => {
        message.textContent = String(error);
      });
  });
  return region;
}
export function diffPane(
  workspace: WorkspaceState,
  pane: DiffPane,
  invoke: Invoke,
): HTMLElement {
  const region = document.createElement("div");
  region.className = "pane-body repository-diff";
  region.setAttribute("role", "region");
  region.setAttribute("aria-label", "Repository diff");
  const title = document.createElement("div");
  title.textContent = pane.repoRoot;
  const mode = document.createElement("div");
  const form = document.createElement("form");
  const base = document.createElement("input");
  base.setAttribute("aria-label", "Base");
  base.value = pane.base ?? "";
  base.placeholder = "Base";
  const head = document.createElement("input");
  head.setAttribute("aria-label", "Head");
  head.value = pane.head ?? "";
  head.placeholder = "Head";
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Compare branches";
  form.append(base, head, button);
  const patch = document.createElement("pre");
  patch.textContent = "Loading diff";
  let generation = 0;
  const load = (compare: boolean) => {
    const requestGeneration = ++generation;
    mode.textContent = compare
      ? "Direct two-tree comparison"
      : "Tracked working changes (staged and unstaged)";
    void invoke<{ patch: string; truncated: boolean }>(
      "git.diff",
      {
        workspace: workspace.id,
        repoRoot: pane.repoRoot,
        ...(compare ? { base: base.value, head: head.value } : {}),
      },
      { reportError: false },
    )
      .then((result) => {
        if (requestGeneration !== generation) return;
        patch.textContent = result.patch || "No tracked changes";
        if (result.truncated)
          patch.append("\nDiff truncated at configured limits.");
      })
      .catch((error) => {
        if (requestGeneration !== generation) return;
        patch.textContent = String(error);
      });
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    load(true);
  };
  region.append(title, mode, form, patch);
  load(pane.base !== undefined);
  return region;
}
