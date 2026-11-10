import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { bitwardenRelease, extractBitwarden } from "./bitwarden-release.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "artifacts/bitwarden"),
  archive = path.join(directory, `bitwarden-${bitwardenRelease.version}.zip`);
await mkdir(directory, { recursive: true });
let bytes;
try {
  bytes = await readFile(archive);
} catch {}
if (
  !bytes ||
  createHash("sha256").update(bytes).digest("hex") !== bitwardenRelease.sha256
) {
  const response = await fetch(bitwardenRelease.url, {
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Bitwarden download failed: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 64 * 1024 * 1024)
      throw new Error("Bitwarden archive exceeds 64 MiB");
    chunks.push(chunk);
  }
  bytes = Buffer.concat(chunks);
  if (
    createHash("sha256").update(bytes).digest("hex") !== bitwardenRelease.sha256
  )
    throw new Error("Official release hash mismatch; refusing changed bytes");
  await writeFile(archive, bytes, { mode: 0o600 });
}
const temporary = path.join(directory, "extract-" + randomUUID()),
  destination = path.join(directory, "extension");
try {
  await extractBitwarden(archive, temporary);
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(
  `Prepared official Bitwarden ${bitwardenRelease.version}; SHA256 ${bitwardenRelease.sha256}`,
);
