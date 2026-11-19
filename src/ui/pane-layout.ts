import { orderedGroups } from "../workspace-layout";
import type { CommandId } from "../keyboard";
import { documentKey, isTextDocument } from "../text-document";
import { createTabDrag } from "./tab-drag";
import { shortcutTitle } from "./keyboard-ui";
import { createNavigationWidths } from "./navigation-widths";
import { conversationLabel } from "./message-label";
import { icon, iconButton, menu, type MenuAction } from "./controls";
import type {
  AppState,
  ConversationState,
  WorkspaceState,
  PaneState,
} from "../types";
import type { Invoke, WhenRendered } from "./contracts";
interface LayoutActions {
  whenRendered: WhenRendered;
  newTab: (workspace: string, group: string) => Promise<void>;
  chooseTabType: (
    anchor: HTMLElement,
    workspace: string,
    group: string,
  ) => void;
  renderPane: (workspace: WorkspaceState, pane: PaneState) => HTMLElement;
  saveFile: (workspace: string, pane: string) => Promise<void>;
  documentModified: (pane: PaneState) => boolean;
  conversationActions: (conversation: ConversationState) => MenuAction[];
  nativeLayout: () => void;
}
export function createPaneLayout(
  getState: () => AppState,
  invoke: Invoke,
  actions: LayoutActions,
) {
  const {
    renderPane,
    saveFile,
    conversationActions,
    nativeLayout,
    documentModified: isDocumentModified,
  } = actions;
  const navigationWidths = createNavigationWidths(invoke);
  const drag = createTabDrag(invoke);
  const activeWorkspace = () =>
    getState().workspaces.find((w) => w.id === getState().activeWorkspaceId);
  const splitButton = iconButton("split", "Toggle split view", () => {
    void toggleSplit().catch(() => undefined);
  });
  splitButton.onpointerdown = (event) => event.preventDefault();
  document.querySelector("#pane-visibility")!.append(splitButton);
  const filesButton = iconButton("folder", "Toggle files", toggleFiles);
  document.querySelector("#visibility-controls")!.append(filesButton);
  const filesPanel = document.querySelector<HTMLElement>("#project-panel")!;
  function applyWorkspaceSettings(workspace?: WorkspaceState): void {
    splitButton.disabled = !workspace;
    splitButton.title = shortcutTitle("pane.zoom", "Toggle split view");
    splitButton.setAttribute(
      "aria-pressed",
      String(
        workspace?.groups.length === 2 &&
          workspace.groups.every((group) => !group.hidden),
      ),
    );
    const settings = workspace?.settings;
    filesPanel.hidden = settings?.filesVisible !== true;
    filesButton.disabled = !workspace;
    filesButton.setAttribute("aria-pressed", String(!filesPanel.hidden));
    filesButton.title = workspace
      ? shortcutTitle("navigation.toggleFiles", "Toggle files")
      : "Select a workspace to show files";
    navigationWidths.apply(workspace);
    document.documentElement.style.setProperty(
      "--chat-max-width",
      settings?.chatMaxWidth
        ? `${settings.chatMaxWidth}px`
        : "var(--chat-default-max-width, 1100px)",
    );
  }
  async function toggleSplit(workspace = activeWorkspace()): Promise<void> {
    if (workspace)
      await invoke("group.toggle-split", { workspace: workspace.id });
  }
  function sidePane(side: "left" | "right", workspace = activeWorkspace()) {
    return (
      workspace &&
      orderedGroups(workspace)[side === "left" ? 0 : 1]?.activePaneId
    );
  }
  async function togglePane(
    side: "left" | "right",
    signal?: AbortSignal,
  ): Promise<void> {
    const workspace = activeWorkspace();
    if (!workspace) return;
    const group = orderedGroups(workspace)[side === "left" ? 0 : 1];
    if (!group) {
      await invoke("group.ensure", { workspace: workspace.id, side });
      return;
    }
    if (
      !group.hidden &&
      workspace.groups.filter((item) => !item.hidden).length === 1
    )
      return;
    const hidden = !group.hidden;
    await invoke("group.visibility", {
      workspace: workspace.id,
      id: group.id,
      hidden,
    });
    if (signal)
      await actions.whenRendered(() => {
        const current = activeWorkspace();
        if (current?.id !== workspace.id) return false;
        return current.groups.find((item) => item.id === group.id)?.hidden ===
          hidden
          ? true
          : undefined;
      }, signal);
  }
  function paneToggleReason(side: "left" | "right"): string | undefined {
    const workspace = activeWorkspace();
    if (!workspace) return "Open a workspace first";
    const group = orderedGroups(workspace)[side === "left" ? 0 : 1];
    if (
      group &&
      !group.hidden &&
      workspace.groups.filter((item) => !item.hidden).length === 1
    )
      return "At least one pane must remain open";
  }
  function toggleFiles(): void {
    const workspace = activeWorkspace();
    if (workspace)
      void invoke("workspace.settings", {
        id: workspace.id,
        settings: { filesVisible: workspace.settings?.filesVisible !== true },
      });
  }
  function renderWorkspace(workspace: WorkspaceState): HTMLElement {
    const groups = orderedGroups(workspace);
    const [left, right] = groups;
    const bothVisible = !!right && !left.hidden && !right.hidden;
    const split = splitViews.get(workspace.id) ?? document.createElement("div");
    splitViews.set(workspace.id, split);
    split.className = "split right";
    const [first, handle, second] = (
      split.childElementCount
        ? [...split.children]
        : [
            document.createElement("div"),
            document.createElement("div"),
            document.createElement("div"),
          ]
    ) as HTMLElement[];
    const ratio =
      workspace.groupLayout.type === "split"
        ? workspace.groupLayout.ratio
        : 0.5;
    for (const [index, child] of [first, second].entries()) {
      const group = groups[index];
      child.className = "split-child";
      child.hidden = !group || !!group.hidden;
      child.style.flex = bothVisible
        ? `${index === 0 ? ratio : 1 - ratio} 1 0`
        : "1 1 0";
      if (!child.hidden) {
        const section = renderGroup(workspace, group);
        if (child.firstElementChild !== section) child.replaceChildren(section);
      }
    }
    handle.className = "split-handle";
    handle.hidden = !bothVisible;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", "Resize panes");
    handle.setAttribute("aria-orientation", "vertical");
    handle.tabIndex = 0;
    const clamp = (value: number) => Math.max(0.15, Math.min(0.85, value));
    const resize = (value: number) =>
      void invoke("group.resize", {
        workspace: workspace.id,
        id: left.id,
        ratio: clamp(value),
      });
    handle.onpointerdown = (event) => {
      if (event.button !== 0) return;
      handle.setPointerCapture(event.pointerId);
      const rect = split.getBoundingClientRect();
      let position = ratio;
      handle.onpointermove = (move) => {
        position = clamp((move.clientX - rect.left) / rect.width);
        first.style.flex = `${position} 1 0`;
        second.style.flex = `${1 - position} 1 0`;
        nativeLayout();
      };
      handle.onpointerup = () => {
        handle.onpointermove = null;
        resize(position);
      };
    };
    handle.onkeydown = (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      resize(ratio + (event.key === "ArrowLeft" ? -0.05 : 0.05));
    };
    if (!split.childElementCount) split.append(first, handle, second);
    return split;
  }
  async function moveTab(
    workspace: WorkspaceState,
    paneId: string,
    groupId: string,
  ): Promise<void> {
    const other = workspace.groups.find((group) => group.id !== groupId);
    if (other)
      await invoke("pane.move", {
        workspace: workspace.id,
        id: paneId,
        group: other.id,
      });
    else
      await invoke("group.split", {
        workspace: workspace.id,
        id: groupId,
        paneId,
        direction: "right",
      });
  }
  function paneLabel(pane: PaneState): string {
    if (pane.kind === "untitled") return pane.name;
    if (pane.kind === "conversation") {
      const c = getState().conversations.find(
        (c) => c.id === pane.conversationId,
      );
      return c ? conversationLabel(c, getState()).slice(0, 80) : "Conversation";
    }
    if (pane.kind === "browser") {
      const b = getState().browsers.find((b) => b.id === pane.browserId);
      return b?.title || b?.url || "Browser";
    }
    if (pane.kind === "terminal") return "Terminal";
    if (pane.kind === "diff")
      return `Changes · ${pane.repoRoot.split("/").pop()}`;
    if (pane.kind === "review") {
      const review = getState().reviews?.find((r) => r.id === pane.reviewId);
      return review?.target.kind === "document"
        ? review.target.path.split("/").pop() || "Review"
        : review?.target.kind === "diff"
          ? `Changes · ${review.target.repoRoot.split("/").pop()}`
          : "Review";
    }
    if (pane.kind === "preview")
      return pane.filePath.split("/").pop() || "Preview";
    if (pane.kind === "empty") return pane.launcher ? "New tab" : "Empty pane";
    return pane.filePath?.split("/").pop() || "New conversation";
  }
  const groupViews = new Map<string, HTMLElement>();
  const splitViews = new Map<string, HTMLElement>();
  function setTabModified(tab: HTMLElement, modified: boolean) {
    tab.dataset.modified = String(modified);
    const marker = tab.querySelector<HTMLElement>(".tab-modified");
    if (marker) marker.hidden = !modified;
    tab.title = tab.dataset.baseTitle! + (modified ? " - Unsaved changes" : "");
  }
  function renderGroup(
    workspace: WorkspaceState,
    group: NonNullable<WorkspaceState["groups"]>[number],
  ): HTMLElement {
    const section =
      groupViews.get(group.id) ?? document.createElement("section");
    groupViews.set(group.id, section);
    section.className = "tab-group";
    section.dataset.groupId = group.id;
    section.setAttribute("aria-label", "Pane");
    const bar =
      section.querySelector<HTMLDivElement>(":scope > .tab-bar") ??
      document.createElement("div");
    bar.className = "tab-bar";
    const tabs =
      bar.querySelector<HTMLDivElement>(".tabs") ??
      document.createElement("div");
    tabs.className = "tabs";
    tabs.setAttribute("role", "tablist");
    const previousTabs = new Map(
      [...tabs.querySelectorAll<HTMLElement>(":scope > .tab")].map((tab) => [
        tab.dataset.tabId!,
        tab,
      ]),
    );
    let tabIndex = 0;
    for (const id of group.paneIds) {
      const pane = workspace.panes.find((p) => p.id === id);
      if (!pane || (pane.kind === "empty" && !pane.launcher)) continue;
      const tab = previousTabs.get(id) ?? document.createElement("div");
      previousTabs.delete(id);
      tab.className = "tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-label", paneLabel(pane));
      tab.setAttribute("aria-selected", String(id === group.activePaneId));
      tab.tabIndex = id === group.activePaneId ? 0 : -1;
      tab.dataset.tabId = id;
      tab.dataset.baseTitle =
        paneLabel(pane) +
        (pane.kind === "review" ? " - Review snapshot" : "") +
        (pane.pinned ? " - Pinned tab" : "");
      if (isTextDocument(pane)) tab.dataset.documentKey = documentKey(pane);
      else delete tab.dataset.documentKey;
      tab.dataset.pinned = String(!!pane.pinned);
      const iconKind =
        pane.kind === "untitled"
          ? "file"
          : pane.kind === "document" && !pane.filePath
            ? "conversation"
            : pane.kind === "empty" && pane.launcher
              ? "plus"
              : pane.kind;
      if (tab.dataset.iconKind !== iconKind) {
        tab.querySelector(":scope > svg")?.remove();
        tab.prepend(icon(iconKind));
        tab.dataset.iconKind = iconKind;
      }
      const label =
        tab.querySelector<HTMLElement>(".tab-label") ??
        document.createElement("span");
      label.className = "tab-label";
      if (label.textContent !== paneLabel(pane))
        label.textContent = paneLabel(pane);
      if (label.parentNode !== tab) tab.append(label);
      const kind =
        tab.querySelector<HTMLElement>(".tab-kind") ??
        document.createElement("small");
      kind.className = "tab-kind";
      kind.textContent = "Review";
      kind.hidden = pane.kind !== "review";
      kind.setAttribute("aria-hidden", "true");
      if (label.nextSibling !== kind) label.after(kind);
      const modified =
        tab.querySelector<HTMLElement>(".tab-modified") ??
        document.createElement("span");
      modified.className = "tab-modified";
      modified.title = "Unsaved changes";
      modified.setAttribute("aria-hidden", "true");
      if (kind.nextSibling !== modified) kind.after(modified);
      setTabModified(tab, isDocumentModified(pane));
      const close =
        tab.querySelector<HTMLButtonElement>(".tab-close") ??
        iconButton("close", "Close tab", () => {});
      close.type = "button";
      close.tabIndex = -1;
      close.setAttribute(
        "aria-label",
        `${pane.pinned ? "Unpin" : "Close"} ${paneLabel(pane)}`,
      );
      close.classList.add("compact", "tab-close");
      close.classList.toggle("tab-pin", !!pane.pinned);
      const endIcon = pane.pinned ? "pin" : "close";
      if (close.dataset.icon !== endIcon) {
        close.replaceChildren(icon(endIcon));
        close.dataset.icon = endIcon;
      }
      close.title = pane.pinned ? "Unpin tab" : shortcutTitle("tab.close");
      close.onpointerdown = () => {
        // A page title may change while the mouse is held. Keep the close target
        // in place until release rather than moving it under the pointer.
        tab.style.width = `${tab.getBoundingClientRect().width}px`;
        const press = new AbortController();
        const release = () => {
          press.abort();
          requestAnimationFrame(() => tab.style.removeProperty("width"));
        };
        window.addEventListener("pointerup", release, {
          signal: press.signal,
          once: true,
        });
        window.addEventListener("pointercancel", release, {
          signal: press.signal,
          once: true,
        });
      };
      close.onclick = (e) => {
        e.stopPropagation();
        void (pane.pinned
          ? invoke("pane.pin", { workspace: workspace.id, id, pinned: false })
          : invoke("pane.close", { workspace: workspace.id, id }));
      };
      if (close.parentNode !== tab) tab.append(close);
      tab.onclick = () => {
        void invoke("pane.focus", { workspace: workspace.id, id })
          .then(() =>
            pane.kind === "conversation"
              ? invoke("conversation.acknowledge", { id: pane.conversationId })
              : undefined,
          )
          .catch(() => undefined);
      };
      tab.onkeydown = (e) => {
        if ((e.target as Element).closest("button")) return;
        if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          tab.click();
        } else if (e.key === "Delete") {
          e.preventDefault();
          void invoke("pane.close", { workspace: workspace.id, id });
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const index = group.paneIds.indexOf(id);
          const next =
            group.paneIds[
              (index +
                (e.key === "ArrowRight" ? 1 : -1) +
                group.paneIds.length) %
                group.paneIds.length
            ];
          void invoke("pane.focus", { workspace: workspace.id, id: next })
            .then(async () => {
              const selected = workspace.panes.find((pane) => pane.id === next);
              if (selected?.kind === "conversation")
                await invoke("conversation.acknowledge", {
                  id: selected.conversationId,
                });
              groupViews
                .get(group.id)
                ?.querySelector<HTMLElement>(`[data-tab-id="${next}"]`)
                ?.focus();
            })
            .catch(() => undefined);
        }
      };
      tab.onauxclick = (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        if (!pane.pinned)
          void invoke("pane.close", { workspace: workspace.id, id });
      };
      tab.draggable = true;
      tab.ondragstart = (e) => drag.start(e, tab, workspace.id, id);
      tab.ondragend = drag.end;
      const actions: MenuAction[] = [
        {
          label: pane.pinned ? "Unpin tab" : "Pin tab",
          command: "tab.togglePin",
          run: () =>
            void invoke("pane.pin", {
              workspace: workspace.id,
              id,
              pinned: !pane.pinned,
            }),
        },
        {
          label: "Close tab",
          command: pane.pinned ? undefined : "tab.close",
          run: () =>
            void invoke("pane.close", {
              workspace: workspace.id,
              id,
              includePinned: true,
            }),
        },
        ...(["others", "left", "right", "all"] as const).map((scope) => ({
          command: (scope === "others"
            ? "tab.closeOthers"
            : scope === "all"
              ? "tab.closeAll"
              : undefined) as CommandId | undefined,
          label: {
            others: "Close other tabs",
            left: "Close tabs to the left",
            right: "Close tabs to the right",
            all: "Close all tabs",
          }[scope],
          disabled: !group.paneIds.some(
            (other, index) =>
              !workspace.panes.find((tab) => tab.id === other)?.pinned &&
              (scope === "all" ||
                (scope === "others"
                  ? other !== id
                  : scope === "left"
                    ? index < group.paneIds.indexOf(id)
                    : index > group.paneIds.indexOf(id))),
          ),
          run: () =>
            void invoke("pane.close-many", {
              workspace: workspace.id,
              group: group.id,
              id,
              scope,
            }),
        })),
        ...([-1, 1] as const).map((delta) => ({
          label: delta < 0 ? "Move tab left" : "Move tab right",
          command: (delta < 0
            ? "tab.reorderLeft"
            : "tab.reorderRight") as CommandId,
          disabled:
            !group.paneIds[group.paneIds.indexOf(id) + delta] ||
            !!workspace.panes.find(
              (tab) =>
                tab.id === group.paneIds[group.paneIds.indexOf(id) + delta],
            )?.pinned !== !!pane.pinned,
          run: () =>
            void invoke("pane.move", {
              workspace: workspace.id,
              id,
              group: group.id,
              index: group.paneIds.indexOf(id) + delta,
            }),
        })),
        {
          label:
            orderedGroups(workspace)[0].id === group.id
              ? "Move to right pane"
              : "Move to left pane",
          command: "tab.moveToPane",
          run: () => void moveTab(workspace, id, group.id),
        },
      ];
      if (pane.kind === "untitled")
        actions.unshift(
          {
            label: "Save as...",
            command: "files.save",
            surface: "editor",
            run: () => void saveFile(workspace.id, pane.id),
          },
          null,
        );
      if (pane.kind === "document" && pane.filePath)
        actions.unshift(
          {
            label: "Save",
            command: "files.save",
            surface: "editor",
            run: () => void saveFile(workspace.id, pane.id),
          },
          {
            label: "Review document",
            command: "review.document",
            run: () =>
              void invoke("review.open-document", {
                workspace: workspace.id,
                path: pane.filePath,
              }),
          },
          ...(/\.md$/i.test(pane.filePath)
            ? [
                {
                  label: "Markdown preview",
                  command: "files.preview" as const,
                  run: () =>
                    void invoke("preview.open", {
                      workspace: workspace.id,
                      path: pane.filePath,
                    }),
                },
              ]
            : []),
          null,
        );
      tab.oncontextmenu = (e) => {
        e.preventDefault();
        const conversation =
          pane.kind === "conversation"
            ? getState().conversations.find((c) => c.id === pane.conversationId)
            : undefined;
        menu(
          { x: e.clientX, y: e.clientY },
          conversation
            ? [...conversationActions(conversation), null, ...actions]
            : actions,
        );
      };
      if (tabs.children[tabIndex] !== tab)
        tabs.insertBefore(tab, tabs.children[tabIndex] ?? null);
      tabIndex++;
    }
    for (const tab of previousTabs.values()) tab.remove();
    drag.bind(bar, tabs, workspace, group);
    const plus =
      bar.querySelector<HTMLButtonElement>('[data-action="new-tab"]') ??
      iconButton("plus", "Choose new tab type", () => {});
    plus.onclick = () => actions.chooseTabType(plus, workspace.id, group.id);
    plus.title = shortcutTitle("tab.chooseType", "Choose new tab type");
    bar.ondblclick = (event) => {
      if (event.button !== 0 || (event.target !== bar && event.target !== tabs))
        return;
      event.preventDefault();
      void actions.newTab(workspace.id, group.id).catch(() => undefined);
    };
    plus.dataset.action = "new-tab";
    if (tabs.parentNode !== bar) bar.append(tabs);
    if (plus.parentNode !== bar) bar.append(plus);
    if (bar.parentNode !== section) section.prepend(bar);
    const pane = workspace.panes.find((p) => p.id === group.activePaneId);
    const previousPreview = bar.querySelector<HTMLButtonElement>(
      '[data-action="preview"]',
    );
    if (
      pane &&
      ((pane.kind === "preview" && pane.format !== "image") ||
        (pane.kind === "document" &&
          /\.md(?:own|arkdown)?$/i.test(pane.filePath ?? "")))
    ) {
      const label =
        pane.kind === "preview" ? "Show source" : "Preview Markdown";
      const preview = previousPreview ?? iconButton("eye", label, () => {});
      preview.title = label;
      preview.setAttribute("aria-label", label);
      preview.onclick = () => {
        void invoke(pane.kind === "preview" ? "file.open" : "preview.open", {
          workspace: workspace.id,
          path: pane.filePath,
        });
      };
      preview.dataset.action = "preview";
      preview.setAttribute("aria-pressed", String(pane.kind === "preview"));
      if (preview.nextSibling !== plus) bar.insertBefore(preview, plus);
    } else previousPreview?.remove();
    if (pane) {
      const content = renderPane(workspace, pane);
      for (const child of [...section.children])
        if (
          child !== bar &&
          child !== content &&
          !child.classList.contains("content-find")
        )
          child.remove();
      if (content.parentNode !== section) section.append(content);
    }
    return section;
  }
  return {
    documentModified(key: string, modified: boolean) {
      for (const group of groupViews.values())
        for (const tab of group.querySelectorAll<HTMLElement>(
          ".tab[data-document-key]",
        ))
          if (tab.dataset.documentKey === key) setTabModified(tab, modified);
    },
    dispose: () => navigationWidths.dispose(),
    render: renderWorkspace,
    applySettings: applyWorkspaceSettings,
    toggleFiles,
    togglePane,
    sidePane,
    paneToggleReason,
    toggleSplit,
    moveTab,
    reconcile() {
      const workspaces = getState().workspaces;
      for (const id of groupViews.keys())
        if (!workspaces.some((w) => w.groups?.some((g) => g.id === id)))
          groupViews.delete(id);
      for (const key of splitViews.keys())
        if (!workspaces.some((w) => key === w.id)) splitViews.delete(key);
    },
  };
}
