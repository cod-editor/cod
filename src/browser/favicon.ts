import { nativeImage, type Session } from "electron";
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

function raster(bytes: Buffer): Buffer | undefined {
  if (smallPng(bytes) || smallJpeg(bytes)) return bytes;
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x00010000) return;
  const entries = bytes.readUInt16LE(4);
  if (entries > 32 || 6 + 16 * entries > bytes.length) return;
  for (let entry = 6; entry < 6 + 16 * entries; entry += 16) {
    const size = bytes.readUInt32LE(entry + 8);
    const start = bytes.readUInt32LE(entry + 12);
    if (start < 6 + 16 * entries || start + size > bytes.length) continue;
    const image = bytes.subarray(start, start + size);
    if (smallPng(image)) return image;
  }
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
      const imageBytes = bytes && raster(bytes);
      if (!imageBytes) continue;
      const image = nativeImage.createFromBuffer(imageBytes);
      if (image.isEmpty()) continue;
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
