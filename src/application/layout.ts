import type { Layout } from "../types";
export function leaf(paneId: string): Layout {
  return { type: "leaf", paneId };
}

export function containsPane(layout: Layout, paneId: string): boolean {
  if (layout.type === "leaf") return layout.paneId === paneId;
  return (
    containsPane(layout.first, paneId) || containsPane(layout.second, paneId)
  );
}

export function replaceLeaf(
  layout: Layout,
  paneId: string,
  replacement: Layout,
): Layout {
  if (layout.type === "leaf")
    return layout.paneId === paneId ? replacement : layout;
  return {
    ...layout,
    first: replaceLeaf(layout.first, paneId, replacement),
    second: replaceLeaf(layout.second, paneId, replacement),
  };
}

export function removeLeaf(layout: Layout, paneId: string): Layout | null {
  if (layout.type === "leaf") return layout.paneId === paneId ? null : layout;
  const first = removeLeaf(layout.first, paneId);
  const second = removeLeaf(layout.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
}

export function firstPane(layout: Layout): string {
  return layout.type === "leaf" ? layout.paneId : firstPane(layout.first);
}

export function containingSplit(
  layout: Layout,
  paneId: string,
): Extract<Layout, { type: "split" }> | null {
  if (layout.type === "leaf") return null;
  if (containsPane(layout.first, paneId)) {
    return containingSplit(layout.first, paneId) ?? layout;
  }
  if (containsPane(layout.second, paneId)) {
    return containingSplit(layout.second, paneId) ?? layout;
  }
  return null;
}

export function resizeSplit(
  layout: Layout,
  target: Layout,
  ratio: number,
): Layout {
  if (layout.type === "leaf") return layout;
  if (layout === target) return { ...layout, ratio };
  return {
    ...layout,
    first: resizeSplit(layout.first, target, ratio),
    second: resizeSplit(layout.second, target, ratio),
  };
}
