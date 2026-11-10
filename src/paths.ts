import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function legacyDataDirectory(): string {
  if (process.env.COD_DATA_DIR) return process.env.COD_DATA_DIR;
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Cod Restart",
    );
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? os.homedir(), "Cod Restart");
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "cod-restart",
  );
}

export function defaultDataDirectory(): string {
  if (process.env.COD_DATA_DIR) return process.env.COD_DATA_DIR;
  return path.join(
    path.dirname(legacyDataDirectory()),
    process.platform === "linux" ? "cod" : "Cod",
  );
}

export function defaultSocketPath(): string {
  if (process.env.COD_SOCKET_PATH) return process.env.COD_SOCKET_PATH;
  if (process.platform === "win32") return "\\\\.\\pipe\\cod";
  return path.join(defaultDataDirectory(), "cod.sock");
}

/** Aliases of the same data directory must share one OS ownership lock. */
export function ownershipLockDirectory(directory: string): string {
  let parent = path.resolve(directory);
  const suffix: string[] = [];
  for (;;) {
    try {
      parent = realpathSync(parent);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      suffix.unshift(path.basename(parent));
      parent = next;
    }
  }
  const resolved = path.join(parent, ...suffix);
  return path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.instance-lock`,
  );
}
