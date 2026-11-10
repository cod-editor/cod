import { highlightedEditor, setChangedLines } from "../editor-highlight";
import { reconcileView } from "./view-reconcile";
import type { AppState, PaneState, WorkspaceState } from "../types";
import type { Invoke } from "./contracts";
export function focusReadyEditor(
  editor: HTMLTextAreaElement,
  stillWanted: () => boolean,
  intent?: AbortController,
): void {
  const focus = () => {
    if (
      editor.isConnected &&
      !editor.disabled &&
      stillWanted() &&
      !intent?.signal.aborted &&
      !document.querySelector("dialog[open]")
    )
      editor.focus({ preventScroll: true });
    intent?.abort();
  };
  if (editor.disabled)
    editor.addEventListener("cod:file-ready", focus, {
      once: true,
      signal: intent?.signal,
    });
  else focus();
}
export function createDocumentViews(
  getState: () => AppState,
  panes: HTMLElement,
  invoke: Invoke,
  invalidate: () => void,
  setStatus: (message: string) => void,
) {
  const drafts = new Map<string, string>();
  const originals = new Map<string, string>();
  const messages = new Map<string, string>();
  const loading = new Set<string>();
  const pendingLoads = new Map<string, Promise<void>>();
  const failedLoads = new Set<string>();
  const lineCache = new Map<string, number[]>();
  const lineLoading = new Set<string>();
  const lineJumped = new Set<string>();
  const savingFiles = new Set<string>();
  function fileKey(paneId: string): string {
    for (const workspace of getState().workspaces) {
      const pane = workspace.panes.find((pane) => pane.id === paneId);
      if (pane?.kind === "document")
        return pane.canonicalPath ?? pane.filePath ?? paneId;
    }
    return paneId;
  }
  function syncDocumentViews(
    key: string,
    value: string,
    source?: HTMLTextAreaElement,
  ): void {
    for (const editor of panes.querySelectorAll<HTMLTextAreaElement>(
      "textarea.file-editor",
    )) {
      if (
        editor === source ||
        editor.dataset.documentKey !== key ||
        editor.value === value
      )
        continue;
      const start = editor.selectionStart,
        end = editor.selectionEnd,
        scrollTop = editor.scrollTop,
        scrollLeft = editor.scrollLeft;
      editor.value = value;
      editor.setSelectionRange(
        Math.min(start, value.length),
        Math.min(end, value.length),
      );
      editor.scrollTop = scrollTop;
      editor.scrollLeft = scrollLeft;
      editor.dispatchEvent(new Event("cod-editor-sync"));
    }
  }

  function loadFile(workspaceId: string, paneId: string): Promise<void> {
    const pending = pendingLoads.get(paneId);
    if (pending) return pending;
    const promise = readFile(workspaceId, paneId).finally(() =>
      pendingLoads.delete(paneId),
    );
    pendingLoads.set(paneId, promise);
    return promise;
  }
  async function readFile(workspaceId: string, paneId: string): Promise<void> {
    loading.add(paneId);
    const key = fileKey(paneId);
    try {
      const result = await invoke<{
        content: string;
        draft?: import("../types").FileDraft;
        unavailable?: boolean;
      }>("file.read", {
        workspace: workspaceId,
        paneId,
      });
      if (!originals.has(key))
        originals.set(key, result.draft?.expectedContent ?? result.content);
      if (result.draft && !drafts.has(key))
        drafts.set(key, result.draft.content);
      failedLoads.delete(paneId);
      if (result.unavailable && result.draft) {
        messages.set(
          paneId,
          "Conflict: file missing or unreadable on disk; restored draft remains editable and copyable.",
        );
        setStatus("File missing; restored draft retained");
      } else if (
        result.draft &&
        result.content !== result.draft.expectedContent
      ) {
        messages.set(
          paneId,
          "Conflict: file changed on disk; restored draft retained.",
        );
        setStatus("External change detected; restored draft retained");
      } else messages.delete(paneId);
    } catch {
      failedLoads.add(paneId);
      messages.set(
        paneId,
        "This file is unavailable. Its saved location remains in the workspace.",
      );
    } finally {
      loading.delete(paneId);
      invalidate();
      views
        .get(paneId)
        ?.querySelector("textarea.file-editor")
        ?.dispatchEvent(new Event("cod:file-ready"));
    }
  }

  async function saveFile(workspaceId: string, paneId: string): Promise<void> {
    const key = fileKey(paneId);
    if (savingFiles.has(key)) {
      setStatus("Save in progress; newer edits remain in the shared draft");
      return;
    }
    if (!originals.has(key)) await loadFile(workspaceId, paneId);
    if (savingFiles.has(key)) return;
    const content = drafts.get(key) ?? originals.get(key);
    const expectedContent = originals.get(key);
    if (content === undefined || expectedContent === undefined) {
      setStatus("The file could not be loaded. Retry loading before saving.");
      return;
    }
    savingFiles.add(key);
    try {
      const result = await invoke<{ saved: boolean; conflict: boolean }>(
        "file.save",
        {
          workspace: workspaceId,
          paneId,
          content,
          expectedContent,
        },
      );
      if (result.conflict) {
        messages.set(
          paneId,
          "Conflict: the file changed on disk. Your unsaved text and the external change were both retained.",
        );
        setStatus("External change detected; local draft retained");
      } else {
        for (const workspace of getState().workspaces)
          for (const pane of workspace.panes)
            if (pane.kind === "document" && fileKey(pane.id) === key) {
              lineCache.delete(pane.id);
              messages.delete(pane.id);
            }
        originals.set(key, content);
        const newer = drafts.get(key);
        if (newer === undefined || newer === content) {
          drafts.delete(key);
          setStatus("File saved");
        } else {
          // The save wrote the captured revision. Keep and rebase subsequent typing.
          await invoke("file.draft", {
            workspace: workspaceId,
            paneId,
            content: newer,
            expectedContent: content,
          });
          setStatus("Saved previous revision; newer edits remain unsaved");
        }
      }
      invalidate();
    } catch {
      messages.set(
        paneId,
        "The file could not be saved. Your local draft is still open.",
      );
      invalidate();
    } finally {
      savingFiles.delete(key);
    }
  }

  function renderDocument(
    workspace: WorkspaceState,
    pane: PaneState,
  ): HTMLElement {
    const body = document.createElement("div");
    body.className = "pane-body";
    if (pane.kind === "document" && pane.filePath) {
      const editor = document.createElement("textarea");
      editor.className = "file-editor";
      editor.setAttribute("aria-label", "File contents");
      editor.spellcheck = false;
      const key = fileKey(pane.id);
      editor.dataset.documentKey = key;
      editor.disabled = !originals.has(key);
      editor.setAttribute(
        "aria-busy",
        String(!originals.has(key) && !failedLoads.has(pane.id)),
      );
      editor.placeholder = originals.has(key)
        ? ""
        : failedLoads.has(pane.id)
          ? "File unavailable"
          : "Loading file...";
      editor.value = drafts.get(key) ?? originals.get(key) ?? "";
      editor.addEventListener("input", () => {
        drafts.set(key, editor.value);
        syncDocumentViews(key, editor.value, editor);
        if (!messages.get(pane.id)?.startsWith("Conflict"))
          messages.delete(pane.id);
        const expectedContent = originals.get(key);
        if (expectedContent !== undefined)
          void invoke("file.draft", {
            workspace: workspace.id,
            paneId: pane.id,
            content: editor.value,
            expectedContent,
          }).catch(() => undefined);
      });
      const highlighted = highlightedEditor(editor, pane.filePath);
      if (lineCache.has(pane.id))
        setChangedLines(highlighted, lineCache.get(pane.id)!);
      else if (!lineLoading.has(pane.id)) {
        lineLoading.add(pane.id);
        void invoke<{ lines: number[] }>("file.lines", {
          workspace: workspace.id,
          paneId: pane.id,
        })
          .then((result) => {
            lineCache.set(pane.id, result.lines);
            const current = panes.querySelector<HTMLElement>(
              `[data-pane-id="${pane.id}"] .highlighted-editor`,
            );
            if (current) setChangedLines(current, result.lines);
          })
          .catch(() => {
            lineCache.set(pane.id, []);
          })
          .finally(() => lineLoading.delete(pane.id));
      }
      body.append(highlighted);
      if (pane.line && originals.has(key) && !lineJumped.has(pane.id)) {
        lineJumped.add(pane.id);
        const position = editor.value
          .split("\n")
          .slice(0, pane.line - 1)
          .reduce((length, line) => length + line.length + 1, 0);
        requestAnimationFrame(() => {
          if (editor.isConnected) {
            editor.setSelectionRange(position, position);
            editor.scrollTop = Math.max(
              0,
              (pane.line! - 2) *
                parseFloat(getComputedStyle(editor).lineHeight),
            );
            editor.dispatchEvent(new Event("scroll"));
          }
        });
      }
      if (
        !originals.has(key) &&
        !loading.has(pane.id) &&
        !failedLoads.has(pane.id)
      ) {
        void loadFile(workspace.id, pane.id);
      }
    } else {
      const empty = document.createElement("div");
      empty.className = "empty-pane";
      const title = document.createElement("strong");
      title.textContent = "Empty document";
      const text = document.createElement("div");
      text.textContent =
        "Open a local file with codctl file open, or split this pane.";
      empty.append(title, text);
      body.append(empty);
    }
    if (messages.has(pane.id)) {
      const message = document.createElement("div");
      message.className = "pane-message";
      message.setAttribute("role", "status");
      message.textContent = messages.get(pane.id)!;
      if (failedLoads.has(pane.id)) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Retry loading file";
        retry.addEventListener("click", () => {
          failedLoads.delete(pane.id);
          void loadFile(workspace.id, pane.id);
        });
        message.append(" ", retry);
      }
      body.append(message);
    }
    return body;
  }

  const views = new Map<string, HTMLElement>();
  return {
    save: saveFile,
    view(workspace: WorkspaceState, pane: PaneState) {
      const next = renderDocument(workspace, pane),
        current = views.get(pane.id);
      if (current) {
        reconcileView(current, next);
        return current;
      }
      views.set(pane.id, next);
      return next;
    },
    reconcile() {
      for (const id of views.keys())
        if (
          !getState().workspaces.some((w) => w.panes.some((p) => p.id === id))
        )
          views.delete(id);
    },
  };
}
