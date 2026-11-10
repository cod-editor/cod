import { shortcutTitle } from "./keyboard-ui";
import { createNavigationWidths } from "./navigation-widths";
import { conversationLabel } from "./message-label";
import { icon, iconButton, menu, type MenuAction } from "./controls";
import type {
  AppState,
  ConversationState,
  WorkspaceState,
  PaneState,
  Layout,
} from "../types";
import type { Invoke } from "./contracts";
interface LayoutActions {
  renderPane: (workspace: WorkspaceState, pane: PaneState) => HTMLElement;
  saveFile: (workspace: string, pane: string) => Promise<void>;
  newConversation: () => Promise<unknown>;
  browserDialog: () => void;
  terminalDialog: () => void;
  openFile: () => void;
  conversationActions: (conversation: ConversationState) => MenuAction[];
  nativeLayout: () => void;
}
export function paneRegions(workspace: WorkspaceState) {
  const regions: {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }[] = [];
  const visit = (layout: Layout, x = 0, y = 0, w = 1, h = 1): void => {
    if (layout.type === "leaf") {
      regions.push({ id: layout.paneId, x, y, w, h });
      return;
    }
    const r = layout.ratio;
    if (layout.direction === "right") {
      visit(layout.first, x, y, w * r, h);
      visit(layout.second, x + w * r, y, w * (1 - r), h);
    } else {
      visit(layout.first, x, y, w, h * r);
      visit(layout.second, x, y + h * r, w, h * (1 - r));
    }
  };
  if (workspace.groupLayout) visit(workspace.groupLayout);
  if (regions.length === 1) {
    const chat = workspace.panes.some(
      (p) =>
        p.kind === "conversation" ||
        p.kind === "terminal" ||
        (p.kind === "document" && !p.filePath),
    );
    regions[0].x = chat ? 0.5 : 0;
    regions[0].w = 0.5;
    regions.push({
      id: chat ? "missing-left" : "missing-right",
      x: chat ? 0 : 0.5,
      y: 0,
      w: 0.5,
      h: 1,
    });
  }
  regions.sort((a, b) => a.y - b.y || a.x - b.x);
  return regions;
}
export function createPaneLayout(
  getState: () => AppState,
  invoke: Invoke,
  actions: LayoutActions,
) {
  const {
    renderPane,
    saveFile,
    newConversation,
    browserDialog,
    terminalDialog,
    openFile,
    conversationActions,
    nativeLayout,
  } = actions;
  const navigationWidths = createNavigationWidths(invoke);
  const activeWorkspace = () =>
    getState().workspaces.find((w) => w.id === getState().activeWorkspaceId);
  function groupFor(
    workspace: WorkspaceState,
    paneId = workspace.activePaneId,
  ) {
    return workspace.groups?.find((group) => group.paneIds.includes(paneId));
  }
  let settingsSignature = "";
  function applyWorkspaceSettings(workspace: WorkspaceState): void {
    navigationWidths.apply(workspace);
    const settings = workspace.settings;
    document
      .querySelector(".sidebar")!
      .toggleAttribute("hidden", settings?.workspacesVisible === false);
    document
      .querySelector("#project-panel")!
      .toggleAttribute("hidden", settings?.filesVisible !== true);
    document.documentElement.style.setProperty(
      "--chat-max-width",
      `${settings?.chatMaxWidth ?? 1100}px`,
    );
    const signature = JSON.stringify([
      workspace.id,
      workspace.settings,
      workspace.groupLayout,
      workspace.zoomedGroupId,
      workspace.groups?.map((g) => [g.id, g.hidden, g.paneIds]),
      workspace.panes.map((p) => [p.id, p.kind]),
    ]);
    if (signature === settingsSignature) return;
    settingsSignature = signature;
    const controls = document.querySelector("#visibility-controls")!;
    controls.replaceChildren();
    for (const [key, name, label] of [
      ["workspacesVisible", "workspace", "Toggle workspaces"],
      ["filesVisible", "folder", "Toggle files"],
    ] as const) {
      const button = iconButton(name, label, () => toggleSetting(key));
      button.setAttribute(
        "aria-pressed",
        String(
          key === "workspacesVisible"
            ? settings?.[key] !== false
            : settings?.[key] === true,
        ),
      );
      controls.append(button);
    }
    const groupControls = document.querySelector("#pane-visibility")!;
    groupControls.replaceChildren();
    const regions = paneRegions(workspace);
    for (const region of regions) {
      const group = workspace.groups?.find((g) => g.id === region.id);
      const visible =
        !!group &&
        !group.hidden &&
        (!workspace.zoomedGroupId || workspace.zoomedGroupId === group.id);
      const position = [
        region.h < 0.99
          ? region.y + region.h / 2 < 0.5
            ? "top"
            : "bottom"
          : "",
        region.w < 0.99
          ? region.x + region.w / 2 < 0.5
            ? "left"
            : "right"
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      const button = iconButton(
        "workspace",
        `${visible ? "Hide" : "Show"} ${position} pane`,
        () => {
          void toggleRegion(region.id);
        },
      );
      if (region.h >= 0.99)
        button.title = shortcutTitle(
          region.x < 0.5 ? "pane.toggleLeft" : "pane.toggleRight",
          button.title,
        );
      if (group) button.dataset.groupId = group.id;
      button.disabled =
        visible &&
        (workspace.groups?.filter((g) => !g.hidden).length ?? 0) <= 1;
      if (button.disabled) button.title = "At least one pane must remain open";
      button.setAttribute("aria-pressed", String(visible));
      const svg = button.querySelector("svg")!;
      svg.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2"/>';
      for (const cell of regions) {
        const rect = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "rect",
        );
        rect.setAttribute("x", String(4 + cell.x * 16));
        rect.setAttribute("y", String(4 + cell.y * 16));
        rect.setAttribute("width", String(Math.max(1, cell.w * 16 - 1)));
        rect.setAttribute("height", String(Math.max(1, cell.h * 16 - 1)));
        rect.setAttribute("stroke", "none");
        rect.setAttribute("fill", "currentColor");
        rect.setAttribute("opacity", cell.id === region.id ? "0.9" : "0.15");
        svg.append(rect);
      }
      groupControls.append(button);
    }
  }
  async function toggleRegion(id: string): Promise<void> {
    const workspace = activeWorkspace();
    if (!workspace) return;
    const region = paneRegions(workspace).find((region) => region.id === id);
    if (!region) return;
    const group = workspace.groups?.find((group) => group.id === id);
    const visible =
      group &&
      !group.hidden &&
      (!workspace.zoomedGroupId || workspace.zoomedGroupId === id);
    if (!group)
      await invoke("group.ensure", {
        workspace: workspace.id,
        side: region.x < 0.5 ? "left" : "right",
      });
    else if (!visible)
      await invoke("pane.focus", {
        workspace: workspace.id,
        id: group.activePaneId,
      });
    else if ((workspace.groups?.filter((g) => !g.hidden).length ?? 0) > 1)
      await invoke("group.visibility", {
        workspace: workspace.id,
        id,
        hidden: true,
      });
  }
  function sideRegion(side: "left" | "right") {
    const workspace = activeWorkspace();
    if (!workspace) return undefined;
    const regions = paneRegions(workspace).sort(
      (a, b) => a.x - b.x || a.y - b.y,
    );
    return side === "left" ? regions[0] : regions.at(-1);
  }
  function togglePane(side: "left" | "right"): Promise<void> {
    const region = sideRegion(side);
    return region ? toggleRegion(region.id) : Promise.resolve();
  }
  function paneToggleReason(side: "left" | "right"): string | undefined {
    const workspace = activeWorkspace();
    if (!workspace) return "Open a workspace first";
    const region = sideRegion(side);
    const group = workspace.groups?.find((g) => g.id === region?.id);
    if (
      group &&
      !group.hidden &&
      (!workspace.zoomedGroupId || workspace.zoomedGroupId === group.id) &&
      (workspace.groups?.filter((g) => !g.hidden).length ?? 0) <= 1
    )
      return "At least one pane must remain open";
  }
  function toggleSetting(key: "workspacesVisible" | "filesVisible"): void {
    const w = activeWorkspace();
    if (w)
      void invoke("workspace.settings", {
        id: w.id,
        settings: {
          [key]: !(key === "workspacesVisible"
            ? w.settings?.[key] !== false
            : w.settings?.[key] === true),
        },
      });
  }
  function renderWorkspace(workspace: WorkspaceState): HTMLElement {
    if (!workspace.groups?.length || !workspace.groupLayout)
      return renderLayout(workspace, workspace.layout);
    if (workspace.zoomedGroupId) {
      const group = workspace.groups.find(
        (g) => g.id === workspace.zoomedGroupId,
      );
      if (group) return renderGroup(workspace, group);
    }
    const build = (layout: Layout, path: number[] = []): HTMLElement | null => {
      if (layout.type === "leaf") {
        const group = workspace.groups!.find((g) => g.id === layout.paneId);
        return group && !group.hidden ? renderGroup(workspace, group) : null;
      }
      const first = build(layout.first, [...path, 0]),
        second = build(layout.second, [...path, 1]);
      if (!first) return second;
      if (!second) return first;
      const splitKey = workspace.id + ":" + path.join(".");
      const split = splitViews.get(splitKey) ?? document.createElement("div");
      splitViews.set(splitKey, split);
      split.className = `split ${layout.direction}`;
      const a =
          (split.children[0] as HTMLElement | undefined) ??
          document.createElement("div"),
        b =
          (split.children[2] as HTMLElement | undefined) ??
          document.createElement("div"),
        handle =
          (split.children[1] as HTMLElement | undefined) ??
          document.createElement("div");
      a.className = b.className = "split-child";
      a.style.flex = `${layout.ratio} 1 0`;
      b.style.flex = `${1 - layout.ratio} 1 0`;
      if (a.firstElementChild !== first) a.replaceChildren(first);
      if (b.firstElementChild !== second) b.replaceChildren(second);
      handle.className = "split-handle";
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-label", "Resize panes");
      handle.tabIndex = 0;
      const firstGroup = (l: Layout): string =>
        l.type === "leaf" ? l.paneId : firstGroup(l.first);
      const resize = (ratio: number) =>
        void invoke("group.resize", {
          workspace: workspace.id,
          id: firstGroup(layout.first),
          path,
          ratio: Math.max(0.15, Math.min(0.85, ratio)),
        });
      handle.onpointerdown = (event) => {
        handle.setPointerCapture(event.pointerId);
        const rect = split.getBoundingClientRect();
        let ratio = layout.ratio;
        handle.onpointermove = (e) => {
          ratio =
            layout.direction === "right"
              ? (e.clientX - rect.left) / rect.width
              : (e.clientY - rect.top) / rect.height;
          ratio = Math.max(0.15, Math.min(0.85, ratio));
          a.style.flex = `${ratio} 1 0`;
          b.style.flex = `${1 - ratio} 1 0`;
          nativeLayout();
        };
        handle.onpointerup = () => {
          handle.onpointermove = null;
          resize(ratio);
        };
      };
      handle.onkeydown = (e) => {
        if (
          ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(e.key)
        ) {
          e.preventDefault();
          resize(
            layout.ratio +
              (["ArrowLeft", "ArrowUp"].includes(e.key) ? -0.05 : 0.05),
          );
        }
      };
      if (!split.childElementCount) split.append(a, handle, b);
      return split;
    };
    return build(workspace.groupLayout) ?? document.createElement("div");
  }
  function paneLabel(pane: PaneState): string {
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
    if (pane.kind === "empty") return "Empty pane";
    return pane.filePath?.split("/").pop() || "New conversation";
  }
  const groupViews = new Map<string, HTMLElement>();
  const splitViews = new Map<string, HTMLElement>();
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
      if (!pane || pane.kind === "empty") continue;
      const tab = previousTabs.get(id) ?? document.createElement("div");
      previousTabs.delete(id);
      tab.className = "tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-label", paneLabel(pane));
      tab.setAttribute("aria-selected", String(id === group.activePaneId));
      tab.tabIndex = id === group.activePaneId ? 0 : -1;
      tab.dataset.tabId = id;
      tab.title = paneLabel(pane);
      const iconKind =
        pane.kind === "document" && !pane.filePath ? "conversation" : pane.kind;
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
      const close =
        tab.querySelector<HTMLButtonElement>(".tab-close") ??
        document.createElement("button");
      close.type = "button";
      close.tabIndex = -1;
      close.setAttribute("aria-label", `Close ${paneLabel(pane)}`);
      close.className = "tab-close";
      if (!close.childElementCount) close.append(icon("close"));
      close.title = shortcutTitle("tab.close");
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
        void invoke("pane.close", { workspace: workspace.id, id });
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
      tab.draggable = true;
      tab.ondragstart = (e) =>
        e.dataTransfer?.setData("application/x-cod-tab", id);
      const actions: MenuAction[] = [
        {
          label: "Close tab",
          run: () => void invoke("pane.close", { workspace: workspace.id, id }),
        },
        ...([-1, 1] as const).map((delta) => ({
          label: delta < 0 ? "Move tab left" : "Move tab right",
          disabled:
            delta < 0
              ? group.paneIds.indexOf(id) === 0
              : group.paneIds.indexOf(id) === group.paneIds.length - 1,
          run: () =>
            void invoke("pane.move", {
              workspace: workspace.id,
              id,
              group: group.id,
              index: group.paneIds.indexOf(id) + delta,
            }),
        })),
        {
          label: "Split right",
          run: () =>
            void invoke("group.split", {
              workspace: workspace.id,
              id: group.id,
              direction: "right",
              paneId: id,
            }),
        },
        {
          label: "Split below",
          run: () =>
            void invoke("group.split", {
              workspace: workspace.id,
              id: group.id,
              direction: "down",
              paneId: id,
            }),
        },
        ...(workspace.groups ?? [])
          .filter((g) => g.id !== group.id)
          .map((g, i) => ({
            label: `Move to pane ${i + 1}`,
            run: () =>
              void invoke("pane.move", {
                workspace: workspace.id,
                id,
                group: g.id,
              }),
          })),
        null,
        {
          label: workspace.zoomedGroupId ? "Restore panes" : "Maximize pane",
          run: () =>
            void invoke("group.zoom", {
              workspace: workspace.id,
              id: group.id,
            }),
        },
      ];
      if (pane.kind === "document" && pane.filePath)
        actions.unshift(
          { label: "Save", run: () => void saveFile(workspace.id, pane.id) },
          {
            label: "Review document",
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
    bar.ondragover = (e) => {
      if (e.dataTransfer?.types.includes("application/x-cod-tab"))
        e.preventDefault();
    };
    bar.ondrop = (e) => {
      e.preventDefault();
      const id = e.dataTransfer?.getData("application/x-cod-tab");
      if (id)
        void invoke("pane.move", {
          workspace: workspace.id,
          id,
          group: group.id,
        });
    };
    const plus =
      bar.querySelector<HTMLButtonElement>('[data-action="new-tab"]') ??
      iconButton("plus", "New tab", () =>
        menu(plus, [
          {
            label: "Open file...",
            run: () => {
              void invoke("group.focus", {
                workspace: workspace.id,
                id: group.id,
              }).then(openFile);
            },
          },
          {
            label: "New chat",
            run: () => {
              void invoke("group.focus", {
                workspace: workspace.id,
                id: group.id,
              }).then(() => newConversation());
            },
          },
          {
            label: "New browser tab",
            run: () => {
              void invoke("group.focus", {
                workspace: workspace.id,
                id: group.id,
              }).then(() => browserDialog());
            },
          },
          {
            label: "New terminal",
            run: () => {
              void invoke("group.focus", {
                workspace: workspace.id,
                id: group.id,
              }).then(() => terminalDialog());
            },
          },
        ]),
      );
    plus.dataset.action = "new-tab";
    const zoom =
      bar.querySelector<HTMLButtonElement>('[data-action="zoom"]') ??
      iconButton(
        workspace.zoomedGroupId ? "restore" : "maximize",
        workspace.zoomedGroupId ? "Restore panes" : "Maximize pane",
        () =>
          void invoke("group.zoom", { workspace: workspace.id, id: group.id }),
      );
    zoom.dataset.action = "zoom";
    const zoomLabel = workspace.zoomedGroupId
      ? "Restore panes"
      : "Maximize pane";
    if (zoom.getAttribute("aria-label") !== zoomLabel) {
      zoom.setAttribute("aria-label", zoomLabel);
      zoom.title = shortcutTitle("pane.zoom", zoomLabel);
      zoom.replaceChildren(
        icon(workspace.zoomedGroupId ? "restore" : "maximize"),
      );
    }
    if (tabs.parentNode !== bar) bar.append(tabs);
    if (plus.parentNode !== bar) bar.append(plus);
    if (zoom.parentNode !== bar) bar.append(zoom);
    if (bar.parentNode !== section) section.prepend(bar);
    const pane = workspace.panes.find((p) => p.id === group.activePaneId);
    if (pane) {
      const content = renderPane(workspace, pane);
      for (const child of [...section.children])
        if (child !== bar && child !== content) child.remove();
      if (content.parentNode !== section) section.append(content);
    }
    return section;
  }
  function renderLayout(
    workspace: WorkspaceState,
    layout: Layout,
  ): HTMLElement {
    if (layout.type === "leaf") {
      const pane = workspace.panes.find((item) => item.id === layout.paneId);
      if (!pane) {
        const missing = document.createElement("div");
        missing.textContent = "Unavailable pane";
        return missing;
      }
      return renderPane(workspace, pane);
    }
    const split = document.createElement("div");
    split.className = `split ${layout.direction}`;
    const first = document.createElement("div");
    const second = document.createElement("div");
    first.className = "split-child";
    second.className = "split-child";
    first.style.flex = `${layout.ratio} 1 0`;
    second.style.flex = `${1 - layout.ratio} 1 0`;
    first.append(renderLayout(workspace, layout.first));
    second.append(renderLayout(workspace, layout.second));
    split.append(first, second);
    return split;
  }

  function splitActive(direction: "right" | "down"): void {
    const w = activeWorkspace(),
      g = w && groupFor(w);
    if (w && g)
      void invoke("group.split", {
        workspace: w.id,
        id: g.id,
        direction,
        paneId: w.activePaneId,
      });
  }
  function zoomActive(): void {
    const w = activeWorkspace(),
      g = w && groupFor(w);
    if (w && g) void invoke("group.zoom", { workspace: w.id, id: g.id });
  }

  return {
    dispose: () => navigationWidths.dispose(),
    render: renderWorkspace,
    applySettings: applyWorkspaceSettings,
    toggle: toggleSetting,
    togglePane,
    paneToggleReason,
    split: splitActive,
    zoom: zoomActive,
    reconcile() {
      const workspaces = getState().workspaces;
      for (const id of groupViews.keys())
        if (!workspaces.some((w) => w.groups?.some((g) => g.id === id)))
          groupViews.delete(id);
      for (const key of splitViews.keys())
        if (!workspaces.some((w) => key.startsWith(w.id + ":")))
          splitViews.delete(key);
    },
  };
}
