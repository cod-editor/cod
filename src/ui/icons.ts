export const icons: Record<string, string> = {
  history: '<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2"/>',
  reset: '<path d="M4 10a8 8 0 1 1 2 8M4 3v7h7"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  workspace:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 8h18M8 8v13"/>',
  folder:
    '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  "folder-open":
    '<path d="M3 17V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 11h18l-2 8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 12h8M8 16h8"/>',
  conversation: '<path d="M4 4h16v12H8l-4 4z"/>',
  review: '<path d="M4 4h16v12H8l-4 4zM8 10h8M12 6v8"/>',
  terminal: '<path d="m4 5 6 6-6 6M13 18h7"/>',
  browser:
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  diff: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17V9c0-4-8-1-8-5"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  pin: '<path d="m16 3 5 5-3 1-4 4v4l-2 2-7-7 2-2h4l4-4zM8 16l-5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  maximize: '<path d="M14 3h7v7M21 3l-7 7M3 14v7h7M3 21l7-7"/>',
  restore: '<path d="M14 3v7h7M14 10l7-7M3 14h7v7M10 14l-7 7"/>',
  left: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  right:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
  chevron: '<path d="m8 5 7 7-7 7"/>',
  back: '<path d="m12 4-8 8 8 8M4 12h16"/>',
  forward: '<path d="m12 4 8 8-8 8M4 12h16"/>',
  reload: '<path d="M20 10a8 8 0 1 0-1 8M20 3v7h-7"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
};
export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  svg.innerHTML = icons[name] ?? icons.file;
  return svg;
}
