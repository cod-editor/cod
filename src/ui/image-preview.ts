/// <reference lib="esnext.typedarrays" />
import type { PreviewPane, WorkspaceState } from "../types";
import type { ImageAttachment } from "../providers/types";
import type { Invoke } from "./contracts";
import { menu } from "./controls";
import { uiButton } from "../ui-kit";

/** A local document preview, with no browser chrome or editable binary text. */
export function imagePreviewPane(
  workspace: WorkspaceState,
  pane: PreviewPane,
  invoke: Invoke,
): HTMLElement {
  const region = document.createElement("div");
  region.className = "pane-body image-preview-pane";
  region.setAttribute("role", "region");
  region.setAttribute("aria-label", "Image preview");
  region.tabIndex = 0;
  const canvas = document.createElement("div");
  canvas.className = "image-preview-canvas";
  canvas.hidden = true;
  const image = document.createElement("img");
  image.alt = pane.filePath.split(/[\\/]/).pop() || "Image";
  image.draggable = false;
  const status = document.createElement("div");
  status.className = "image-preview-status";
  status.setAttribute("role", "status");
  const retry = uiButton("Retry");
  retry.hidden = true;
  canvas.append(image);
  region.append(canvas, status, retry);
  let url: string | undefined;
  let fit = true,
    scale = 1,
    revision = 0,
    disposed = false;
  const paint = () => {
    if (!image.naturalWidth || !region.clientWidth || !region.clientHeight)
      return;
    if (fit) {
      const padding = getComputedStyle(canvas);
      scale = Math.min(
        1,
        Math.max(
          1,
          region.clientWidth -
            parseFloat(padding.paddingLeft) -
            parseFloat(padding.paddingRight),
        ) / image.naturalWidth,
        Math.max(
          1,
          region.clientHeight -
            parseFloat(padding.paddingTop) -
            parseFloat(padding.paddingBottom),
        ) / image.naturalHeight,
      );
    }
    image.style.width = `${Math.max(1, image.naturalWidth * scale)}px`;
    image.style.height = `${Math.max(1, image.naturalHeight * scale)}px`;
    image.title = `${image.alt} · ${image.naturalWidth} × ${image.naturalHeight} · ${Math.round(scale * 100)}%. Click for actual size or fit; + / - to zoom, 0 to fit, 1 for actual size.`;
    image.style.cursor = fit && scale < 1 ? "zoom-in" : "zoom-out";
  };
  const zoom = (value: number | "fit") => {
    fit = value === "fit";
    if (!fit) scale = Math.max(0.05, Math.min(16, value as number));
    paint();
    region.scrollLeft = Math.max(0, (image.width - region.clientWidth) / 2);
    region.scrollTop = Math.max(0, (image.height - region.clientHeight) / 2);
  };
  const refresh = async () => {
    const current = ++revision;
    status.textContent = "Loading image...";
    status.hidden = false;
    canvas.hidden = true;
    retry.hidden = true;
    try {
      const result = await invoke<{ image: ImageAttachment }>(
        "preview.read",
        { workspace: workspace.id, id: pane.id },
        { reportError: false },
      );
      if (disposed || current !== revision) return;
      const bytes = Uint8Array.fromBase64(result.image.data);
      const next = URL.createObjectURL(
        new Blob([bytes], { type: result.image.mimeType }),
      );
      if (url) URL.revokeObjectURL(url);
      url = next;
      image.src = next;
    } catch (error) {
      if (disposed || current !== revision) return;
      status.textContent =
        error instanceof Error ? error.message : String(error);
      retry.hidden = false;
    }
  };
  image.onload = () => {
    status.textContent = "";
    status.hidden = true;
    canvas.hidden = false;
    paint();
  };
  image.onerror = () => {
    canvas.hidden = true;
    status.hidden = false;
    status.textContent = "The image could not be decoded.";
    retry.hidden = false;
  };
  image.onclick = () => {
    region.focus();
    zoom(fit ? 1 : "fit");
  };
  const actions = (x: number, y: number) =>
    menu({ x, y }, [
      { label: "Zoom in", run: () => zoom(scale * 1.25) },
      { label: "Zoom out", run: () => zoom(scale / 1.25) },
      { label: "Fit to pane", run: () => zoom("fit") },
      { label: "Actual size", run: () => zoom(1) },
      null,
      {
        label: "Reload image",
        run: () => {
          void refresh();
        },
      },
    ]);
  region.oncontextmenu = (e) => {
    e.preventDefault();
    actions(e.clientX, e.clientY);
  };
  region.onkeydown = (e) => {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const r = region.getBoundingClientRect();
      actions(r.x + 20, r.y + 20);
      return;
    }
    const value =
      e.key === "0"
        ? "fit"
        : e.key === "1"
          ? 1
          : ["+", "="].includes(e.key)
            ? scale * 1.25
            : e.key === "-"
              ? scale / 1.25
              : undefined;
    if (value !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      zoom(value);
    }
  };
  region.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoom(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    { passive: false },
  );
  retry.onclick = () => {
    void refresh();
  };
  const resize = new ResizeObserver(() => {
    if (fit) paint();
  });
  resize.observe(region);
  region.addEventListener("cod:refresh-preview", () => {
    void refresh();
  });
  const dispose = () => {
    disposed = true;
    revision++;
    resize.disconnect();
    if (url) URL.revokeObjectURL(url);
    url = undefined;
    image.onload = image.onerror = null;
    image.removeAttribute("src");
  };
  region.addEventListener("cod:dispose-view", dispose, { once: true });
  void refresh();
  return region;
}
