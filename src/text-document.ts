import type { PaneState } from "./types";

export type TextDocument = Extract<
  PaneState,
  { kind: "document" | "untitled" }
>;

export function isTextDocument(pane: PaneState): pane is TextDocument {
  return (
    pane.kind === "untitled" || (pane.kind === "document" && !!pane.filePath)
  );
}

export function documentKey(pane: TextDocument): string {
  if (pane.kind === "untitled") return `untitled:${pane.id}`;
  const key = pane.canonicalPath ?? pane.filePath;
  if (!key) throw new Error("A chat placeholder is not a text document");
  return key;
}
