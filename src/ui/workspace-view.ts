import { actionButton as paneButton } from "./action-feedback";
import { reviewPane, updateReview } from "../review-pane";
import { previewPane, diffPane } from "../resource-panes";
import type { AppState, WorkspaceState, PaneState } from "../types";
import type { Invoke } from "./contracts";
import type { createConversationViews } from "./conversation-views";
import type { createDocumentViews } from "./document-views";
import type { createBrowserViews } from "./browser-views";
import type { createTerminalViews } from "./terminal-views";
import type { createPaneLayout } from "./pane-layout";
import type { createWorkspaceNavigation } from "./workspace-navigation";
import type { createFocusManager } from "./focus";
import type { FileTree } from "./files";
interface Views {
  chats: ReturnType<typeof createConversationViews>;
  documents: ReturnType<typeof createDocumentViews>;
  browsers: ReturnType<typeof createBrowserViews>;
  terminals: ReturnType<typeof createTerminalViews>;
  layout: ReturnType<typeof createPaneLayout>;
  navigation: ReturnType<typeof createWorkspaceNavigation>;
  focus: ReturnType<typeof createFocusManager>;
  projects: FileTree;
}
export function createWorkspaceView(
  panes: HTMLElement,
  workspaceName: HTMLElement,
  getState: () => AppState,
  invoke: Invoke,
  setStatus: (message: string) => void,
  createWorkspace: () => void,
  views: Views,
) {
  const {
    chats,
    documents,
    browsers,
    terminals,
    layout,
    navigation,
    focus,
    projects,
  } = views;
  const resourcePanes = new Map<string, HTMLElement>();
  const activeWorkspace = () =>
    getState().workspaces.find((w) => w.id === getState().activeWorkspaceId);
  const viewScrolls = new Map<string, { top: number; bottom: boolean }>();
  const editorSelections = new Map<
    string,
    { start: number; end: number; top: number; left: number }
  >();
  function render(): void {
    const activeElement = document.activeElement as HTMLElement | null;
    const scrolls = viewScrolls;
    for (const input of panes.querySelectorAll<HTMLTextAreaElement>(
      "textarea",
    )) {
      const id = input.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
      if (id)
        editorSelections.set(id + ":" + input.getAttribute("aria-label"), {
          start: input.selectionStart,
          end: input.selectionEnd,
          top: input.scrollTop,
          left: input.scrollLeft,
        });
    }
    for (const element of panes.querySelectorAll<HTMLElement>(".transcript")) {
      const id = element.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
      if (id)
        scrolls.set(id, {
          top: element.scrollTop,
          bottom:
            element.scrollHeight - element.clientHeight - element.scrollTop <
            60,
        });
    }
    browsers.reconcile();
    const returnFocus = focus.capture();
    chats.reconcile();
    documents.reconcile();
    layout.reconcile();
    terminals.reconcile();
    navigation.render();
    const workspace = activeWorkspace();
    projects.update(workspace);
    for (const id of resourcePanes.keys())
      if (
        !getState().workspaces.some((workspace) =>
          workspace.panes.some((pane) => pane.id === id),
        )
      )
        resourcePanes.delete(id);
    workspaceName.textContent = workspace?.name ?? "No workspace";
    if (!workspace) {
      const empty = document.createElement("div");
      empty.className = "empty-workspace";
      const content = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = "Cod";
      const text = document.createElement("p");
      text.append(paneButton("New workspace", async () => createWorkspace()));
      content.append(title, text);
      empty.append(content);
      panes.replaceChildren(empty);
    } else {
      layout.applySettings(workspace);
      const content = layout.render(workspace);
      if (panes.firstElementChild !== content) panes.replaceChildren(content);
    }
    for (const element of panes.querySelectorAll<HTMLElement>(".transcript")) {
      const id = element.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
      const saved = id ? scrolls.get(id) : undefined;
      element.scrollTop =
        saved && !saved.bottom ? saved.top : element.scrollHeight;
    }
    for (const input of panes.querySelectorAll<HTMLTextAreaElement>(
      "textarea",
    )) {
      const id = input.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
      const saved = id
        ? editorSelections.get(id + ":" + input.getAttribute("aria-label"))
        : undefined;
      if (saved) {
        input.setSelectionRange(saved.start, saved.end);
        input.scrollTop = saved.top;
        input.scrollLeft = saved.left;
        if (input.classList.contains("file-editor"))
          input.dispatchEvent(new Event("scroll"));
      }
    }
    // Native views retain their own focus and selection across renderer updates.
    // Restoring an old native origin here can undo an explicit tab switch before
    // its new layout has been applied. Only modal cancellation restores it.
    if (!returnFocus.browserId) {
      focus.restore(returnFocus);
      if (activeElement?.isConnected && activeElement.closest("[data-pane-id]"))
        activeElement.focus({ preventScroll: true });
    }
    browsers.layout();
  }

  function renderPane(workspace: WorkspaceState, pane: PaneState): HTMLElement {
    let container = resourcePanes.get(pane.id);
    const kind =
      pane.kind === "document" && !pane.filePath ? "draft-chat" : pane.kind;
    if (container?.dataset.viewKind !== kind) container = undefined;
    if (!container) {
      container = document.createElement("section");
      container.className = "pane";
      container.dataset.testid = "pane";
      container.dataset.paneId = pane.id;
      container.dataset.viewKind = kind;
      container.addEventListener("focusin", () => {
        const current = getState().workspaces.find((w) =>
          w.panes.some((item) => item.id === pane.id),
        );
        if (current && current.activePaneId !== pane.id)
          void invoke("pane.focus", {
            workspace: current.id,
            id: pane.id,
          }).catch(() => undefined);
      });
      resourcePanes.set(pane.id, container);
    }
    container.dataset.active = String(workspace.activePaneId === pane.id);
    let content: HTMLElement | undefined;
    if (pane.kind === "empty") {
      container.setAttribute("aria-label", "Empty pane");
      container.tabIndex = 0;
    } else if (pane.kind === "conversation") {
      const conversation = getState().conversations.find(
        (c) => c.id === pane.conversationId,
      );
      container.setAttribute(
        "aria-label",
        `${conversation?.provider ?? "Agent"} conversation`,
      );
      if (conversation) content = chats.conversation(conversation);
    } else if (pane.kind === "document") {
      container.setAttribute(
        "aria-label",
        pane.filePath
          ? `File pane ${pane.filePath.split("/").pop()}`
          : "New conversation",
      );
      content = pane.filePath
        ? documents.view(workspace, pane)
        : chats.draft(workspace, pane);
    } else if (pane.kind === "review") {
      const previous = container.querySelector<HTMLElement>(".review-body");
      if (previous) updateReview(previous, getState());
      else content = reviewPane(pane.reviewId, getState(), invoke);
    } else if (pane.kind === "preview" || pane.kind === "diff") {
      if (!container.childElementCount)
        content =
          pane.kind === "preview"
            ? previewPane(workspace, pane, invoke)
            : diffPane(workspace, pane, invoke);
    } else if (pane.kind === "browser") {
      const record = getState().browsers.find((b) => b.id === pane.browserId);
      if (
        record &&
        !browsers.update(record, workspace.activePaneId === pane.id)
      )
        browsers.create(container, record);
    } else if (pane.kind === "terminal") {
      const record = getState().terminals.find((t) => t.id === pane.terminalId);
      container.setAttribute("aria-label", `Terminal ${pane.terminalId}`);
      if (
        record &&
        !terminals.update(record, workspace.activePaneId === pane.id)
      )
        terminals.create(container, record);
    }
    if (content && container.firstElementChild !== content)
      container.replaceChildren(content);
    return container;
  }

  async function openReference(
    workspace: string,
    reference: string,
  ): Promise<void> {
    const result = await invoke<{
      candidates: Array<{ path: string }>;
      line?: number;
    }>("file.resolve", { workspace, path: reference });
    const open = (path: string) =>
      invoke("file.open", {
        workspace,
        path,
        ...(result.line ? { line: result.line } : {}),
      });
    if (!result.candidates.length) {
      setStatus(`File not found in workspace folders: ${reference}`);
      return;
    }
    if (result.candidates.length === 1) {
      await open(result.candidates[0].path);
      return;
    }
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "Choose file");
    const title = document.createElement("h2");
    title.textContent = "Choose file";
    dialog.append(title);
    for (const candidate of result.candidates) {
      const button = paneButton(candidate.path, async () => {
        await open(candidate.path);
        dialog.close();
      });
      dialog.append(button);
    }
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.onclick = () => dialog.close();
    dialog.append(cancel);
    document.body.append(dialog);
    dialog.onclose = () => dialog.remove();
    dialog.showModal();
    dialog.querySelector("button")?.focus();
  }
  const events = new AbortController();
  window.addEventListener(
    "message",
    (event) => {
      if (
        event.data?.type !== "cod-preview-link" ||
        typeof event.data.href !== "string"
      )
        return;
      for (const workspace of getState().workspaces)
        for (const pane of workspace.panes) {
          if (pane.kind !== "preview") continue;
          const frame = resourcePanes.get(pane.id)?.querySelector("iframe");
          if (frame?.contentWindow !== event.source) continue;
          const href = event.data.href;
          if (/^https?:\/\//.test(href))
            void invoke("browser.open", {
              workspace: workspace.id,
              url: href,
            }).catch(() => undefined);
          else if (!/^[a-z]+:/i.test(href) && !href.startsWith("#"))
            void openReference(workspace.id, href).catch(() => undefined);
        }
    },
    { signal: events.signal },
  );

  return {
    render,
    pane: renderPane,
    openReference,
    dispose() {
      events.abort();
      resourcePanes.clear();
    },
  };
}
