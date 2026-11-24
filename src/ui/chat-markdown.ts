import { Marked, marked } from "marked";

export const visualizationStart = "\ue200visualize\ue202";

export function chatMarkdown(source: string, assistant: boolean) {
  const visualizations: Array<{ path: string; title?: string; raw: string }> =
    [];
  if (!assistant || !source.includes(visualizationStart))
    return { html: marked.parse(source, { async: false }), visualizations };

  const parser = new Marked({
    extensions: [
      {
        name: "visualization",
        level: "block",
        start(source) {
          const start = source.indexOf("\n" + visualizationStart);
          return start >= 0 ? start + 1 : undefined;
        },
        tokenizer(source) {
          const match =
            /^\ue200visualize\ue202([^\n]{1,8192})\ue201[ \t]*(?:\n+|$)/.exec(
              source,
            );
          if (!match) return;
          try {
            const reference = JSON.parse(match[1]);
            const path = reference?.path;
            if (
              typeof path !== "string" ||
              !/^\/[^\r\n\0]+\.html?$/i.test(path)
            )
              return;
            const title =
              typeof reference.title === "string"
                ? reference.title.trim().replace(/\s+/g, " ").slice(0, 120)
                : undefined;
            return { type: "visualization", raw: match[0], path, title };
          } catch {
            // An incomplete response or a literal example stays text.
          }
        },
        renderer(token) {
          const index =
            visualizations.push({
              path: token.path,
              title: token.title,
              raw: token.raw.trimEnd(),
            }) - 1;
          return `<p data-cod-visualization="${index}"></p>\n`;
        },
      },
    ],
  });
  return { html: parser.parse(source, { async: false }), visualizations };
}
