import { marked } from "marked";
import DOMPurify from "dompurify";
import mermaid from "mermaid";
import { highlight } from "./editor-highlight";
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  theme: "dark",
  maxTextSize: 100_000,
});
let revision = 0;
window.addEventListener("message", (event) => {
  if (
    event.source !== parent ||
    event.data?.type !== "cod-preview" ||
    typeof event.data.content !== "string"
  )
    return;
  const generation = ++revision;
  void (async () => {
    const main = document.querySelector("main")!;
    if (event.data.content.length > 2_000_000) {
      main.textContent = "Preview exceeds 2 MB limit";
      return;
    }
    const parsed = await marked.parse(event.data.content);
    if (generation !== revision) return;
    main.innerHTML = DOMPurify.sanitize(parsed, {
      FORBID_TAGS: [
        "img",
        "iframe",
        "style",
        "form",
        "input",
        "object",
        "embed",
      ],
      FORBID_ATTR: ["style"],
    });
    for (const link of main.querySelectorAll<HTMLAnchorElement>("a")) {
      const href = link.getAttribute("href") ?? "";
      if (/^(javascript|data|vbscript):/i.test(href))
        link.removeAttribute("href");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        parent.postMessage({ type: "cod-preview-link", href }, "*");
      });
    }
    for (const code of main.querySelectorAll<HTMLElement>("pre code")) {
      const language =
        [...code.classList]
          .find((item) => item.startsWith("language-"))
          ?.slice(9) ?? "plaintext";
      if (language === "mermaid") {
        try {
          const result = await mermaid.render(
            `diagram-${generation}-${crypto.randomUUID()}`,
            code.textContent ?? "",
          );
          if (generation !== revision) return;
          const rendered = document.createElement("div");
          rendered.innerHTML = DOMPurify.sanitize(result.svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            FORBID_TAGS: ["foreignObject", "script"],
            FORBID_ATTR: ["onload"],
          });
          code.parentElement!.replaceWith(rendered);
        } catch {
          code.textContent = "Diagram could not be rendered.";
        }
      } else code.innerHTML = highlight(code.textContent ?? "", language);
    }
  })().catch(() => {
    document.querySelector("main")!.textContent =
      "Preview could not be rendered.";
  });
});
