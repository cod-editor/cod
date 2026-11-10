import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
export const bitwardenRelease = {
  version: "2026.10.2",
  sha256: "2ebc61246a2ea82a65c589b8484e26a5678253fa6474c26dc5b6a7a7fcacbda4",
  url: "https://github.com/bitwarden/clients/releases/download/browser-v2026.10.2/dist-chrome-2026.10.2.zip",
  source: "https://github.com/bitwarden/clients/tree/browser-v2026.10.2",
  license:
    "https://github.com/bitwarden/clients/blob/browser-v2026.10.2/LICENSE.txt",
};
export async function extractBitwarden(archive, destination) {
  const bytes = await readFile(archive);
  if (
    createHash("sha256").update(bytes).digest("hex") !== bitwardenRelease.sha256
  )
    throw new Error(
      "Bitwarden archive does not match the pinned official release",
    );
  await mkdir(destination, { recursive: true });
  await promisify(execFile)("unzip", ["-q", archive, "-d", destination], {
    timeout: 60000,
  });
  const manifest = JSON.parse(
    await readFile(path.join(destination, "manifest.json"), "utf8"),
  );
  if (manifest.version !== bitwardenRelease.version)
    throw new Error("Bitwarden manifest version mismatch");
  await writeFile(
    path.join(destination, "COD-PROVENANCE.json"),
    JSON.stringify(bitwardenRelease, null, 2) + "\n",
  );
}
