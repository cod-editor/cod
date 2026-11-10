import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Unpacked extensions without manifest.key derive their identity from this path.
// Keep executable files under the profile, independent of release directories.
export async function prepareExtension(
  source: string,
  directory: string,
): Promise<string> {
  const destination = path.join(directory, "bitwarden");
  if (path.resolve(source) === path.resolve(destination)) {
    await extensionDigest(destination);
    return destination;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = path.join(directory, ".bitwarden-previous");
  const staged = path.join(directory, ".bitwarden-install");
  const exists = async (file: string) => {
    try {
      return await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  // Recover an interrupted replacement before comparing versions.
  if (!(await exists(destination)) && (await exists(previous)))
    await rename(previous, destination);
  const fingerprint = await extensionDigest(source);
  if (await exists(destination)) {
    if (fingerprint === (await extensionDigest(destination)))
      return destination;
  }
  await rm(staged, { recursive: true, force: true });
  try {
    await cp(source, staged, {
      recursive: true,
      filter: async (file) => {
        if ((await lstat(file)).isSymbolicLink())
          throw new Error("Extension installation cannot contain symlinks");
        return true;
      },
    });
    if (
      (await extensionDigest(staged)) !== fingerprint ||
      (await extensionDigest(source)) !== fingerprint
    )
      throw new Error("Extension payload changed during installation");
    await rm(previous, { recursive: true, force: true });
    if (await exists(destination)) await rename(destination, previous);
    try {
      await rename(staged, destination);
    } catch (error) {
      if (await exists(previous)) await rename(previous, destination);
      throw error;
    }
    await rm(previous, { recursive: true, force: true });
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
  return destination;
}

async function extensionDigest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(current: string, relative: string): Promise<void> {
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new Error("Extension installation cannot contain symlinks");
    if (info.isDirectory()) {
      for (const name of (await readdir(current)).sort())
        await visit(path.join(current, name), path.join(relative, name));
    } else if (info.isFile()) {
      hash.update(JSON.stringify(relative));
      hash.update(String(info.size));
      hash.update(await readFile(current));
    } else throw new Error("Extension installation requires regular files");
  }
  await visit(directory, "");
  return hash.digest("hex");
}
