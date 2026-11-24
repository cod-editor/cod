export function codexItemsCursor(metadata: unknown): string | undefined {
  const cursor = (metadata as { itemsBackwardsCursor?: unknown } | null)
    ?.itemsBackwardsCursor;
  return typeof cursor === "string" && cursor ? cursor : undefined;
}
