import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";

export interface BuildInfo {
  id: string;
  sourceHash: string;
  revision: string | null;
  dirty: boolean | null;
  version: string;
}
declare const __COD_BUILD_ID__: string;

/** Capture once from the loaded main bundle, never from later files on disk. */
export function startupBuildInfo(
  directory: string,
): Readonly<BuildInfo> | null {
  const loadedId =
    typeof __COD_BUILD_ID__ === "string" ? __COD_BUILD_ID__ : null;
  if (!loadedId) return null;
  try {
    const file = path.join(directory, "build-info.json");
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 65536) return null;
    const value = JSON.parse(readFileSync(file, "utf8"));
    const build = value.build;
    if (
      value.schema !== 1 ||
      build?.id !== loadedId ||
      !/^[a-f0-9]{64}$/.test(build.sourceHash) ||
      !(build.revision === null || /^[a-f0-9]{40,64}$/.test(build.revision)) ||
      !(build.dirty === null || typeof build.dirty === "boolean") ||
      typeof build.version !== "string" ||
      !/^[a-zA-Z0-9.+-]{1,64}$/.test(build.version)
    )
      return null;
    return Object.freeze({
      id: loadedId,
      sourceHash: build.sourceHash,
      revision: build.revision,
      dirty: build.dirty,
      version: build.version,
    });
  } catch {
    return null;
  }
}
