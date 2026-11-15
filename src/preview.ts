import { renderMarkdown } from "./markdown-view";
let revision = 0;
window.addEventListener("message", (event) => {
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
