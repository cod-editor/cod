import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceHostTarget } from "./protocol";

export function workspaceHostTarget(raw: unknown): WorkspaceHostTarget {
  const { alias, socketPath, publicKey } = (raw ??
    {}) as Partial<WorkspaceHostTarget>;
  if (
    typeof alias !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(alias)
  )
    throw new Error("Enter an OpenSSH host alias");
  if (
    typeof socketPath !== "string" ||
    !path.posix.isAbsolute(socketPath) ||
    /[:\u0000-\u001f\u007f]/.test(socketPath) ||
    Buffer.byteLength(socketPath) > 107
  )
    throw new Error("Enter a valid absolute Linux workspace socket path");
  if (
    publicKey !== undefined &&
    (typeof publicKey !== "string" || Buffer.byteLength(publicKey) > 8192)
  )
    throw new Error("Enter a valid SSH public key for private review");
  return { alias, socketPath, publicKey: publicKey || undefined };
}

export async function readWorkspaceHostTarget(profile: string) {
  try {
    const saved = await readFile(
      path.join(profile, "workspace-host.json"),
      "utf8",
    );
    if (saved.length > 16384)
      throw new Error("Linux workspace target is too large");
    return workspaceHostTarget(JSON.parse(saved));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      "The saved Linux workspace configuration is invalid. Connect from Commands to replace it.",
    );
  }
}

export async function saveWorkspaceHostTarget(
  profile: string,
  target: WorkspaceHostTarget,
) {
  const file = path.join(profile, "workspace-host.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(target) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
