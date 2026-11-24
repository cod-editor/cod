export function siteFavicon(value: string | undefined): string | undefined {
  if (
    typeof value === "string" &&
    value.length < 7_000 &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value)
  )
    return value;
}

export function siteIcon(src: string): HTMLImageElement {
  const image = document.createElement("img");
  image.className = "site-favicon";
  image.alt = "";
  image.src = src;
  return image;
}
