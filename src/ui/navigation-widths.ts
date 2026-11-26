import type { WorkspaceState } from "../types";
import type { Invoke } from "./contracts";

/** Owns panel geometry. Viewport clamping never changes the saved preferred width. */
export function createNavigationWidths(invoke: Invoke) {
  let workspace: WorkspaceState | undefined;
  let dragging = false;
  const events = new AbortController();
  const host = document.querySelector<HTMLElement>("#project-panel")!;
  const handle = document.createElement("div");
  const maximum = () =>
    Math.max(160, Math.min(800, Math.floor(innerWidth * 0.4)));
  const clamp = (width: number) => Math.max(160, Math.min(maximum(), width));
  function paint(width: number) {
    const actual = clamp(width);
    host.style.width = `${actual}px`;
    handle.setAttribute("aria-valuenow", String(actual));
    handle.setAttribute("aria-valuemin", "160");
    handle.setAttribute("aria-valuemax", String(maximum()));
  }
  function apply(next: WorkspaceState | undefined) {
    workspace = next;
    handle.hidden = host.hidden;
    if (!dragging) paint(next?.settings?.filesWidth ?? 210);
  }
  async function save(width: number, workspaceId: string) {
    handle.setAttribute("aria-busy", "true");
    try {
      await invoke("workspace.settings", {
        id: workspaceId,
        settings: { filesWidth: Math.round(width) },
      });
    } catch {
      apply(workspace);
    } finally {
      handle.removeAttribute("aria-busy");
    }
  }
  host.classList.add("resizable-navigation");
  handle.className = "navigation-handle";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-label", "Resize files");
  handle.setAttribute("aria-orientation", "vertical");
  handle.title = "Resize files";
  handle.tabIndex = 0;
  host.after(handle);
  handle.onpointerdown = (event) => {
    if (!workspace || event.button !== 0) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    const id = workspace.id,
      startX = event.clientX,
      startWidth = host.getBoundingClientRect().width;
    dragging = true;
    let width = startWidth;
    handle.onpointermove = (move) => {
      width = clamp(startWidth + move.clientX - startX);
      paint(width);
    };
    const finish = (persist: boolean) => {
      dragging = false;
      handle.onpointermove = null;
      handle.onpointerup = null;
      handle.onpointercancel = null;
      if (persist) void save(width, id);
      else apply(workspace);
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
    paint(width);
    void save(width, workspace.id);
  };
  window.addEventListener("resize", () => apply(workspace), {
    signal: events.signal,
  });
  return {
    apply,
    dispose() {
      events.abort();
      handle.remove();
    },
  };
}
