import { nativeImage, type NativeImage, type Session } from "electron";
import { faviconOrigin } from "./favicon-origin";
import type { FavoriteArt, SiteIcons } from "./site-icon-types";

const limit = 64 * 1024;

async function readIcon(response: Response): Promise<Buffer | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    if (!response.ok || Number(response.headers.get("content-length")) > limit)
      return;
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > limit) return;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function smallPng(bytes: Buffer): boolean {
  return (
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    [bytes.readUInt32BE(16), bytes.readUInt32BE(20)].every(
      (size) => size > 0 && size <= 256,
    )
  );
}

function smallJpeg(bytes: Buffer): boolean {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let end = 2;
  while (end + 8 < bytes.length && bytes[end++] === 0xff) {
    const marker = bytes[end++]!;
    const length = bytes.readUInt16BE(end);
    if (length < 2 || end + length > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2].includes(marker))
      return (
        length >= 8 &&
        [bytes.readUInt16BE(end + 3), bytes.readUInt16BE(end + 5)].every(
          (size) => size > 0 && size <= 256,
        )
      );
    end += length;
  }
  return false;
}

function bitmapIcon(bytes: Buffer): NativeImage | undefined {
  // An ICO frame stores a bottom-up color bitmap followed by a 1-bit mask.
  const header = 40;
  if (bytes.length < header || bytes.readUInt32LE(0) !== header) return;
  const width = bytes.readInt32LE(4);
  const height = bytes.readInt32LE(8) / 2;
  const bits = bytes.readUInt16LE(14);
  if (
    width < 1 ||
    width > 256 ||
    !Number.isInteger(height) ||
    height < 1 ||
    height > 256 ||
    bytes.readUInt16LE(12) !== 1 ||
    (bits !== 24 && bits !== 32) ||
    bytes.readUInt32LE(16) !== 0 ||
    bytes.readUInt32LE(32) !== 0
  )
    return;

  const pixelBytes = bits / 8;
  const stride = Math.ceil((width * pixelBytes) / 4) * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const maskStart = header + stride * height;
  if (maskStart + maskStride * height > bytes.length) return;

  // A 32-bit frame's all-zero alpha channel denotes legacy mask transparency.
  let hasAlpha = false;
  if (bits === 32)
    for (let offset = header + 3; offset < maskStart; offset += 4)
      if (bytes[offset] !== 0) {
        hasAlpha = true;
        break;
      }

  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceRow = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const source = header + sourceRow * stride + x * pixelBytes;
      const mask = bytes[maskStart + sourceRow * maskStride + (x >> 3)]!;
      const alpha = hasAlpha
        ? bytes[source + 3]!
        : mask & (0x80 >> (x % 8))
          ? 0
          : 255;
      const destination = (y * width + x) * 4;
      // Electron's native bitmap uses premultiplied BGRA on Cod's platforms.
      for (let channel = 0; channel < 3; channel++)
        pixels[destination + channel] = Math.round(
          (bytes[source + channel]! * alpha) / 255,
        );
      pixels[destination + 3] = alpha;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width, height });
}

function raster(bytes: Buffer): NativeImage | undefined {
  if (smallPng(bytes) || smallJpeg(bytes))
    return nativeImage.createFromBuffer(bytes);
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x00010000) return;
  const entries = bytes.readUInt16LE(4);
  if (entries > 32 || 6 + 16 * entries > bytes.length) return;
  let bitmap: NativeImage | undefined;
  let bitmapEdge = 0;
  for (let entry = 6; entry < 6 + 16 * entries; entry += 16) {
    const size = bytes.readUInt32LE(entry + 8);
    const start = bytes.readUInt32LE(entry + 12);
    if (start < 6 + 16 * entries || start + size > bytes.length) continue;
    const image = bytes.subarray(start, start + size);
    if (smallPng(image)) {
      const png = nativeImage.createFromBuffer(image);
      if (!png.isEmpty()) return png;
    } else {
      const frame = bitmapIcon(image);
      if (frame) {
        const { width, height } = frame.getSize();
        const edge = Math.max(width, height);
        if (edge > bitmapEdge) {
          bitmap = frame;
          bitmapEdge = edge;
        }
      }
    }
  }
  return bitmap;
}

function fit(image: NativeImage, edge: number): NativeImage {
  const { width, height } = image.getSize();
  if (Math.max(width, height) <= edge) return image;
  return image.resize(width >= height ? { width: edge } : { height: edge });
}

function pngData(png: Buffer): string {
  return "data:image/png;base64," + png.toString("base64");
}

function favoriteArt(image: NativeImage): FavoriteArt | undefined {
  const { width, height } = image.getSize();
  if (Math.max(width, height) <= 32) return;
  const pixels = image.toBitmap();
  if (pixels.length !== width * height * 4) return;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let opaque = true;
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++) {
      const alpha = pixels[(row * width + col) * 4 + 3];
      if (alpha !== 255) opaque = false;
      if (!alpha) continue;
      left = Math.min(left, col);
      top = Math.min(top, row);
      right = Math.max(right, col);
      bottom = Math.max(bottom, row);
    }
  if (right < left || bottom < top) return;
  const piece = opaque
    ? image
    : image.crop({
        x: left,
        y: top,
        width: right - left + 1,
        height: bottom - top + 1,
      });
  const size = piece.getSize();
  if (Math.max(size.width, size.height) <= 32) return;
  const kind = opaque && width === height && width >= 64 ? "cover" : "mark";
  for (const edge of [128, 96, 64]) {
    const image = fit(piece, edge);
    const png = image.toPNG();
    if (png.length && png.length <= 20 * 1024)
      return { kind, png: pngData(png), ...image.getSize() };
  }
}

function lightFavoriteArt(image: NativeImage): FavoriteArt | undefined {
  const icon = fit(image, 32);
  const pixels = icon.toBitmap();
  let transparent = false;
  let hasInk = false;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3]!;
    if (alpha < 16) {
      transparent = true;
      continue;
    }
    hasInk = true;
    // The bitmap channels are premultiplied by alpha.
    const brightest = Math.max(
      pixels[offset]!,
      pixels[offset + 1]!,
      pixels[offset + 2]!,
    );
    if (brightest * 255 > alpha * 72) return;
  }
  if (!transparent || !hasInk) return;
  const png = icon.toPNG();
  if (png.length && png.length <= 20 * 1024)
    return { kind: "light", png: pngData(png), ...icon.getSize() };
}

async function fetchIcon(
  session: Session,
  origin: string,
  url: string,
  signal: AbortSignal,
): Promise<NativeImage | undefined> {
  if (url.length > 2048 || faviconOrigin(url) !== origin) return;
  try {
    const response = await session.fetch(url, {
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
    });
    const bytes = await readIcon(response);
    const image = bytes && raster(bytes);
    if (image && !image.isEmpty()) return image;
  } catch {
    // An unavailable icon must not change the page's navigation state.
  }
}

export async function loadSiteIcons(
  session: Session,
  pageOrigin: string,
  candidates: readonly string[],
  signal: AbortSignal,
  update: (icons: SiteIcons) => void,
  mode: "tab" | "pinned" | "touch",
): Promise<void> {
  let favicon: string | undefined;
  let largest = 0;
  const declared = candidates.slice(0, mode === "touch" ? 2 : 4);
  const conventional = pageOrigin + "/favicon.ico";
  const candidatesWithFallback = [...declared];
  if (mode !== "touch" && !declared.includes(conventional))
    candidatesWithFallback.push(conventional);
  for (const [index, url] of candidatesWithFallback.entries()) {
    const fallback = index === declared.length;
    if (signal.aborted || (fallback && favicon)) return;
    const image = await fetchIcon(session, pageOrigin, url, signal);
    if (!image || signal.aborted) continue;
    const candidate =
      favoriteArt(image) ??
      (url === conventional ? lightFavoriteArt(image) : undefined);
    const size = candidate ? candidate.width * candidate.height : 0;
    const art = size > largest ? candidate : undefined;
    if (art) largest = size;
    if (!favicon && mode !== "touch") {
      const tab = fit(image, 32).toPNG();
      if (tab.length && tab.length <= 5 * 1024) favicon = pngData(tab);
      if (favicon || art) update({ favicon, favoriteArt: art });
    } else if (art) update({ favoriteArt: art });
    if (mode === "tab" && favicon) return;
  }
}
