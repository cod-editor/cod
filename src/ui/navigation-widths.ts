import type { WorkspaceState } from "../types";
import type { Invoke } from "./contracts";

type WidthSetting = "workspacesWidth" | "filesWidth";
interface NavigationPanel {
  host: HTMLElement;
  handle: HTMLElement;
  setting: WidthSetting;
  visible: "workspacesVisible" | "filesVisible";
}
/** Owns panel geometry. Viewport clamping never changes the saved preferred width. */
export function createNavigationWidths(invoke: Invoke) {
  let workspace: WorkspaceState | undefined;
  let dragging: WidthSetting | undefined;
  const events = new AbortController();
  const panels: NavigationPanel[] = [];
  const maximum = () =>
    Math.max(160, Math.min(800, Math.floor(innerWidth * 0.4)));
  const clamp = (width: number) => Math.max(160, Math.min(maximum(), width));
  function paint(panel: NavigationPanel, width: number) {
    const actual = clamp(width);
    panel.host.style.width = `${actual}px`;
    panel.handle.setAttribute("aria-valuenow", String(actual));
    panel.handle.setAttribute("aria-valuemin", "160");
    panel.handle.setAttribute("aria-valuemax", String(maximum()));
  }
  function apply(next = workspace) {
    workspace = next;
    for (const panel of panels) {
      panel.handle.hidden =
        !next ||
        (panel.visible === "workspacesVisible"
          ? next.settings?.workspacesVisible === false
          : next.settings?.filesVisible !== true);
      if (dragging !== panel.setting)
        paint(panel, next?.settings?.[panel.setting] ?? 210);
    }
  }
  async function save(
    panel: NavigationPanel,
    width: number,
    workspaceId: string,
  ) {
    panel.handle.setAttribute("aria-busy", "true");
    try {
      await invoke("workspace.settings", {
        id: workspaceId,
        settings: { [panel.setting]: Math.round(width) },
      });
    } catch {
      apply();
    } finally {
      panel.handle.removeAttribute("aria-busy");
    }
  }
  for (const [selector, setting, visible, label] of [
    [".sidebar", "workspacesWidth", "workspacesVisible", "Resize workspaces"],
    ["#project-panel", "filesWidth", "filesVisible", "Resize files"],
  ] as const) {
    const host = document.querySelector<HTMLElement>(selector)!;
    host.classList.add("resizable-navigation");
    const handle = document.createElement("div");
    handle.className = "navigation-handle";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", label);
    handle.setAttribute("aria-orientation", "vertical");
    handle.title = label;
    handle.tabIndex = 0;
    host.after(handle);
    const panel = { host, handle, setting, visible };
    panels.push(panel);
    handle.onpointerdown = (event) => {
      if (!workspace || event.button !== 0) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(event.pointerId);
      const id = workspace.id,
        startX = event.clientX,
        startWidth = host.getBoundingClientRect().width;
      dragging = setting;
      let width = startWidth;
      handle.onpointermove = (move) => {
        width = clamp(startWidth + move.clientX - startX);
        paint(panel, width);
      };
      const finish = (persist: boolean) => {
        dragging = undefined;
        handle.onpointermove = null;
        handle.onpointerup = null;
        handle.onpointercancel = null;
        if (persist) void save(panel, width, id);
        else apply();
      };
      handle.onpointerup = () => finish(true);
      handle.onpointercancel = () => finish(false);
    };
    handle.onkeydown = (event) => {
      if (
        !workspace ||
        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
      )
        return;
      event.preventDefault();
      const current = host.getBoundingClientRect().width;
      const width =
        event.key === "Home"
          ? 160
          : event.key === "End"
            ? maximum()
            : clamp(current + (event.key === "ArrowLeft" ? -16 : 16));
      paint(panel, width);
      void save(panel, width, workspace.id);
    };
  }
  window.addEventListener("resize", () => apply(), { signal: events.signal });
  return {
    apply,
    dispose() {
      events.abort();
      for (const panel of panels) panel.handle.remove();
    },
  };
}
