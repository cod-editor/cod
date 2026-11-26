import type { FavoriteArt } from "../browser/site-icon-types";

const pngData = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;

export function siteFavicon(value: string | undefined): string | undefined {
  if (typeof value === "string" && value.length < 7_000 && pngData.test(value))
    return value;
}

export function siteFavoriteArt(
  value: FavoriteArt | undefined,
): FavoriteArt | undefined {
  if (
    value &&
    (value.kind === "mark" ||
      value.kind === "cover" ||
      value.kind === "light") &&
    typeof value.png === "string" &&
    value.png.length <= 27_332 &&
    pngData.test(value.png)
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
