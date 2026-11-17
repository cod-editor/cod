import { uiButton } from "./primitives";
import { confirmAction } from "./dialogs";
import { highlightedEditor, setChangedLines } from "../editor-highlight";
import { reconcileView } from "./view-reconcile";
import type { AppState, PaneState, WorkspaceState } from "../types";
import type { Invoke } from "./contracts";
import { documentKey, isTextDocument } from "../text-document";
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
  const versions = new Map<string, string>();
  const messages = new Map<string, string>();
  const loading = new Set<string>();
  const pendingLoads = new Map<string, Promise<void>>();
  const failedLoads = new Set<string>();
  const lineCache = new Map<string, number[]>();
  const lineLoading = new Set<string>();
  const lineJumped = new Set<string>();
  const savingFiles = new Set<string>();
  const draftWrites = new Map<string, Promise<unknown>>();
  const failedDraftWrites = new Set<string>();
  const paneKeys = new Map<string, string>();
  const saveAs = new Map<
    string,
    { key: string; content: string; completed: boolean }
  >();
  function pruneBuffers(): void {
    const documents = getState().workspaces.flatMap((workspace) =>
      workspace.panes.filter(isTextDocument),
    );
    const open = new Set(documents.map(documentKey));
    const openIds = new Set(documents.map((pane) => pane.id));
    for (const pending of saveAs.values()) open.add(pending.key);
    for (const key of originals.keys())
      if (
        !open.has(key) &&
        !savingFiles.has(key) &&
        !draftWrites.has(key) &&
        !failedDraftWrites.has(key)
      ) {
        drafts.delete(key);
        originals.delete(key);
        versions.delete(key);
      }
    for (const [id, key] of paneKeys)
      if (
        !openIds.has(id) &&
        !loading.has(id) &&
        !saveAs.has(id) &&
        !savingFiles.has(key) &&
        !draftWrites.has(key) &&
        !failedDraftWrites.has(key)
      ) {
        paneKeys.delete(id);
        messages.delete(id);
        lineCache.delete(id);
        lineJumped.delete(id);
        failedLoads.delete(id);
      }
  }
  function persistDraft(key: string, values: Record<string, unknown>): void {
    const write = invoke("file.draft", values, { reportError: false });
    draftWrites.set(key, write);
    void write.then(
      () => {
        if (draftWrites.get(key) !== write) return;
        draftWrites.delete(key);
        failedDraftWrites.delete(key);
        pruneBuffers();
      },
      () => {
        if (draftWrites.get(key) !== write) return;
        draftWrites.delete(key);
        failedDraftWrites.add(key);
        setStatus(
          "Could not save this file draft. Keep Cod open and retry before closing.",
        );
      },
    );
  }
  function fileKey(paneId: string): string {
    for (const workspace of getState().workspaces) {
      const pane = workspace.panes.find((pane) => pane.id === paneId);
      if (pane && isTextDocument(pane)) {
        const key = documentKey(pane),
          previous = paneKeys.get(paneId),
          pending = saveAs.get(paneId);
        const editor = panes.querySelector<HTMLTextAreaElement>(
          `[data-pane-id="${paneId}"] textarea.file-editor`,
        );
        const renderedKey = editor?.dataset.documentKey;
        const oldKey = renderedKey?.startsWith("untitled:")
          ? renderedKey
          : previous;
        if (key.startsWith("untitled:") && previous && previous !== key) {
          const content = drafts.get(previous);
          if (content !== undefined) drafts.set(key, content);
          originals.set(key, "");
        }
        if (oldKey && oldKey !== key && oldKey.startsWith("untitled:")) {
          const content = drafts.get(oldKey);
          if (pending || !originals.has(key))
            originals.set(key, pending?.content ?? originals.get(oldKey) ?? "");
          if (content !== undefined) drafts.set(key, content);
        }
        paneKeys.set(paneId, key);
        if (
          pending?.completed &&
          key !== pending.key &&
          renderedKey !== pending.key
        ) {
          originals.delete(pending.key);
          drafts.delete(pending.key);
          versions.delete(pending.key);
          saveAs.delete(paneId);
        }
        return key;
      }
    }
    return paneKeys.get(paneId) ?? paneId;
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
    const originalAtRead = originals.get(key);
    try {
      const result = await invoke<{
        content: string;
        draft?: import("../types").FileDraft;
        unavailable?: boolean;
        version?: string;
      }>("file.read", {
        workspace: workspaceId,
        paneId,
      });
      if (originalAtRead !== undefined && originals.get(key) !== originalAtRead)
        return;
      if (result.version) versions.set(key, result.version);
      if (!originals.has(key)) {
        originals.set(key, result.draft?.expectedContent ?? result.content);
        if (result.draft && !drafts.has(key))
          drafts.set(key, result.draft.content);
      }
      const local = drafts.get(key);
      const dirty = local !== undefined && local !== originals.get(key);
      failedLoads.delete(paneId);
      if (result.unavailable) {
        messages.set(
          paneId,
          "Conflict: file missing or unreadable on disk; local draft retained.",
        );
      } else if (dirty && result.content !== originals.get(key)) {
        messages.set(
          paneId,
          "Conflict: the file changed on disk. Your unsaved text is retained.",
        );
      } else if (!dirty) {
        originals.set(key, result.content);
        drafts.delete(key);
        syncDocumentViews(key, result.content);
        messages.delete(paneId);
        // A clean persisted draft must not restore obsolete disk content later.
        if (
          result.draft &&
          (result.draft.content !== result.content ||
            result.draft.expectedContent !== result.content)
        )
          await invoke("file.draft", {
            workspace: workspaceId,
            paneId,
            content: result.content,
            expectedContent: result.content,
          });
      } else messages.delete(paneId);
      lineCache.delete(paneId);
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
      const pane = getState()
        .workspaces.find((item) => item.id === workspaceId)
        ?.panes.find((item) => item.id === paneId);
      if (pane?.kind === "untitled") {
        const choice = await window.cod.chooseSaveFile(workspaceId, paneId);
        if (!choice) return;
        const latest = drafts.get(key) ?? originals.get(key) ?? "";
        saveAs.set(paneId, { key, content: latest, completed: false });
        const result = await invoke<{
          saved: boolean;
          conflict: boolean;
          path?: string;
        }>("file.save-as", {
          workspace: workspaceId,
          paneId,
          path: choice.path,
          content: latest,
          ...(choice.expectedContent === undefined
            ? {}
            : { expectedContent: choice.expectedContent }),
        });
        if (result.conflict) {
          saveAs.delete(paneId);
          messages.set(
            paneId,
            "Conflict: the destination changed. Your untitled text is retained; choose its destination again.",
          );
          setStatus("Destination changed; untitled text retained");
        } else {
          const pending = saveAs.get(paneId)!;
          pending.completed = true;
          const next = fileKey(paneId),
            newer = drafts.get(next);
          messages.delete(paneId);
          lineCache.delete(paneId);
          if (next !== key && newer === latest) drafts.delete(next);
          setStatus(
            newer !== undefined && newer !== latest
              ? "Saved previous revision; newer edits remain unsaved"
              : "File saved",
          );
        }
        invalidate();
        return;
      }
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
      saveAs.delete(paneId);
      messages.set(
        paneId,
        "Save did not complete. Your draft is retained; check the destination before retrying.",
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
    if (isTextDocument(pane)) {
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
        const currentKey = editor.dataset.documentKey!;
        drafts.set(currentKey, editor.value);
        syncDocumentViews(currentKey, editor.value, editor);
        if (!messages.get(pane.id)?.startsWith("Conflict"))
          messages.delete(pane.id);
        const expectedContent =
          originals.get(currentKey) ??
          (currentKey.startsWith("untitled:") ? "" : undefined);
        if (expectedContent !== undefined)
          persistDraft(currentKey, {
            workspace: workspace.id,
            paneId: pane.id,
            content: editor.value,
            expectedContent,
            sourceKey: currentKey,
          });
      });
      const highlighted = highlightedEditor(
        editor,
        pane.kind === "document" ? (pane.filePath ?? "") : "",
      );
      if (lineCache.has(pane.id))
        setChangedLines(highlighted, lineCache.get(pane.id)!);
      else if (!lineLoading.has(pane.id)) {
        lineLoading.add(pane.id);
        void invoke<{ lines: number[] }>("file.lines", {
          workspace: workspace.id,
          paneId: pane.id,
        })
          .then((result) => {
            if (fileKey(pane.id) !== key) return;
            lineCache.set(pane.id, result.lines);
            const current = panes.querySelector<HTMLElement>(
              `[data-pane-id="${pane.id}"] .highlighted-editor`,
            );
            if (current) setChangedLines(current, result.lines);
          })
          .catch(() => {
            lineCache.set(pane.id, []);
          })
          .finally(() => {
            lineLoading.delete(pane.id);
            if (!lineCache.has(pane.id)) invalidate();
          });
      }
      body.append(highlighted);
      if (
        pane.kind === "document" &&
        pane.line &&
        originals.has(key) &&
        !lineJumped.has(pane.id)
      ) {
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
      if (
        pane.kind === "document" &&
        messages.get(pane.id)?.startsWith("Conflict") &&
        !failedLoads.has(pane.id)
      ) {
        const reload = uiButton("Reload from disk");
        reload.onclick = () =>
          confirmAction(
            "Discard local changes?",
            "Reloading replaces your unsaved text with the current file on disk.",
            "Discard and reload",
            async () => {
              const result = await invoke<{
                content: string;
                unavailable?: boolean;
                version?: string;
              }>("file.read", { workspace: workspace.id, paneId: pane.id });
              if (result.unavailable)
                throw new Error("The file is unavailable; local text retained");
              await invoke("file.draft", {
                workspace: workspace.id,
                paneId: pane.id,
                content: result.content,
                expectedContent: result.content,
              });
              const key = fileKey(pane.id);
              originals.set(key, result.content);
              drafts.delete(key);
              if (result.version) versions.set(key, result.version);
              messages.delete(pane.id);
              syncDocumentViews(key, result.content);
              invalidate();
            },
          );
        message.append(" ", reload);
      }
      if (
        pane.kind === "untitled" &&
        messages.get(pane.id)?.startsWith("Conflict")
      ) {
        const retry = uiButton("Save as...");
        retry.onclick = () => void saveFile(workspace.id, pane.id);
        message.append(" ", retry);
      }
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

  let refreshing = false;
  async function refreshVisibleFiles(): Promise<void> {
    if (refreshing || document.hidden) return;
    refreshing = true;
    try {
      const checked = new Set<string>();
      for (const editor of panes.querySelectorAll<HTMLTextAreaElement>(
        "textarea.file-editor",
      )) {
        if (!editor.getClientRects().length) continue;
        const paneId =
          editor.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
        if (!paneId || loading.has(paneId)) continue;
        const key = fileKey(paneId);
        if (checked.has(key) || savingFiles.has(key)) continue;
        checked.add(key);
        const workspace = getState().workspaces.find((w) =>
          w.panes.some((p) => p.id === paneId),
        );
        if (!workspace || !originals.has(key)) continue;
        try {
          const result = await invoke<{ version: string }>(
            "file.version",
            { workspace: workspace.id, paneId },
            { reportError: false },
          );
          if (versions.get(key) !== result.version) {
            versions.set(key, result.version);
            await loadFile(workspace.id, paneId);
          }
        } catch {
          /* Pane closed or moved while the read was pending. */
        }
      }
    } finally {
      refreshing = false;
    }
  }
  const refreshTimer = setInterval(() => {
    void refreshVisibleFiles();
  }, 1500);
  const refreshOnFocus = () => {
    void refreshVisibleFiles();
  };
  window.addEventListener("focus", refreshOnFocus);
  panes.addEventListener("focusin", refreshOnFocus);
  const views = new Map<string, HTMLElement>();
  return {
    save: saveFile,
    dispose() {
      clearInterval(refreshTimer);
      window.removeEventListener("focus", refreshOnFocus);
      panes.removeEventListener("focusin", refreshOnFocus);
    },
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
      pruneBuffers();
    },
  };
}
