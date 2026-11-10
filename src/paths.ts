import os from "node:os";
import path from "node:path";

export function defaultDataDirectory(): string {
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

export function defaultSocketPath(): string {
  if (process.env.COD_SOCKET_PATH) return process.env.COD_SOCKET_PATH;
  if (process.platform === "win32") return "\\\\.\\pipe\\cod-restart";
  return path.join(defaultDataDirectory(), "cod.sock");
}
