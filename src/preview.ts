import { renderMarkdown } from "./markdown-view";
let revision = 0;
let linkReturn: { element: HTMLElement; range?: Range } | undefined;
window.addEventListener("message", (event) => {
  if (
    event.source === parent &&
    event.data?.type === "cod-preview-link-restore"
  ) {
    const origin = linkReturn;
    linkReturn = undefined;
    if (origin?.element.isConnected)
      origin.element.focus({ preventScroll: true });
    if (
      origin?.range?.startContainer.isConnected &&
      origin.range.endContainer.isConnected
    ) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(origin.range);
    }
    return;
  }
  if (
    event.source !== parent ||
    event.data?.type !== "cod-preview" ||
    typeof event.data.content !== "string"
  )
    return;
  const generation = ++revision;
  const main = document.querySelector("main")!;
  void renderMarkdown(
    main,
    event.data.content,
    () => generation === revision,
  ).catch((error) => {
    if (generation === revision) main.textContent = String(error);
  });
});
document.addEventListener("click", (event) => {
  const link = (event.target as Element).closest("a");
  if (!link) return;
  event.preventDefault();
  parent.postMessage(
    { type: "cod-preview-link", href: link.getAttribute("href") ?? "" },
    "*",
  );
});

document.addEventListener("contextmenu", (event) => {
  const link = (event.target as Element).closest("a");
  const href = link?.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(href)) return;
  event.preventDefault();
  const selection = window.getSelection();
  linkReturn = {
    element: document.activeElement as HTMLElement,
    range: selection?.rangeCount
      ? selection.getRangeAt(0).cloneRange()
      : undefined,
  };
  parent.postMessage(
    { type: "cod-preview-link-menu", href, x: event.clientX, y: event.clientY },
    "*",
  );
});

document.addEventListener("keydown", (event) => {
  if (!(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)))
    return;
  const link = document.activeElement?.closest("a");
  if (!link || !/^https?:\/\//i.test(link.getAttribute("href") ?? "")) return;
  event.preventDefault();
  const rect = link.getBoundingClientRect();
  link.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.x,
      clientY: rect.bottom,
    }),
  );
});
