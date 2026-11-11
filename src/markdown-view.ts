import DOMPurify from "dompurify";
import { markdownDocument } from "./markdown-document";
import { highlight } from "./editor-highlight";

/** The normal preview and review use the same Markdown and diagram renderer. */
export async function renderMarkdown(
  main: HTMLElement,
  source: string,
  current: () => boolean = () => true,
) {
  if (source.length > 2_000_000) throw new Error("Preview exceeds 2 MB limit");
  const blocks = markdownDocument(source);
  main.replaceChildren();
  for (const block of blocks) {
    if (!block.html) continue;
    const element = document.createElement("section");
    element.className = "markdown-block";
    element.dataset.textStart = String(block.start);
    element.dataset.textEnd = String(block.end);
    element.innerHTML = DOMPurify.sanitize(block.html, {
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
    main.append(element);
  }
  for (const code of main.querySelectorAll<HTMLElement>("pre code")) {
    const language =
      [...code.classList]
        .find((item) => item.startsWith("language-"))
        ?.slice(9) ?? "plaintext";
    if (language !== "mermaid") {
      code.innerHTML = highlight(code.textContent ?? "", language);
      continue;
    }
    try {
      const { default: mermaid } = await import("mermaid");
      if (!current()) return;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
        theme: "dark",
        maxTextSize: 100_000,
      });
      const result = await mermaid.render(
        `diagram-${crypto.randomUUID()}`,
        code.textContent ?? "",
      );
      if (!current()) return;
      const diagram = document.createElement("div");
      diagram.dataset.diagram = "true";
      diagram.innerHTML = DOMPurify.sanitize(result.svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ["foreignObject", "script"],
        FORBID_ATTR: ["onload"],
      });
      code.parentElement!.replaceWith(diagram);
    } catch {
      code.parentElement!.dataset.diagram = "true";
      code.textContent = "Diagram could not be rendered.";
    }
  }
}
