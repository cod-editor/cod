import { nativeImage, type NativeImage, type Session } from "electron";
import { faviconOrigin } from "./favicon-origin";

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
  for (let entry = 6; entry < 6 + 16 * entries; entry += 16) {
    const size = bytes.readUInt32LE(entry + 8);
    const start = bytes.readUInt32LE(entry + 12);
    if (start < 6 + 16 * entries || start + size > bytes.length) continue;
    const image = bytes.subarray(start, start + size);
    if (smallPng(image)) {
      const png = nativeImage.createFromBuffer(image);
      if (!png.isEmpty()) return png;
    } else bitmap ??= bitmapIcon(image);
  }
  return bitmap;
}

export async function loadFavicon(
  session: Session,
  pageOrigin: string,
  candidates: readonly string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  for (const value of candidates.slice(0, 4)) {
    if (signal.aborted) return;
    if (value.length > 2048 || faviconOrigin(value) !== pageOrigin) continue;
    try {
      const response = await session.fetch(value, {
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      });
      const bytes = await readIcon(response);
      const image = bytes && raster(bytes);
      if (!image || image.isEmpty()) continue;
      const { width, height } = image.getSize();
      const reduced =
        Math.max(width, height) <= 32
          ? image
          : image.resize(width >= height ? { width: 32 } : { height: 32 });
      const png = reduced.toPNG();
      if (png.length <= 5 * 1024)
        return "data:image/png;base64," + png.toString("base64");
    } catch {
      // An unavailable icon must not change the page's navigation state.
    }
  }
}
