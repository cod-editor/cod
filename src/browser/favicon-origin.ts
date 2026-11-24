export function faviconOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    )
      return url.origin;
  } catch {
    // Blank, local, and malformed addresses have no site icon.
  }
}
