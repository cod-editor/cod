import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceHostSelection } from "./protocol";

export function workspaceHostSelection(raw: unknown): WorkspaceHostSelection {
  const { alias, socketPath, publicKey } = (raw ??
    {}) as Partial<WorkspaceHostSelection>;
  if (
    typeof alias !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(alias)
  )
    throw new Error("Enter an OpenSSH host alias");
  if (socketPath !== undefined && !validWorkspaceSocket(socketPath))
    throw new Error("Enter a valid absolute Linux workspace socket path");
  if (
    publicKey !== undefined &&
    (typeof publicKey !== "string" || Buffer.byteLength(publicKey) > 8192)
  )
    throw new Error("Enter a valid SSH public key for private review");
  return { alias, socketPath, publicKey: publicKey || undefined };
}

export function validWorkspaceSocket(value: unknown): value is string {
  return (
    typeof value === "string" &&
    path.posix.isAbsolute(value) &&
    !/[:\u0000-\u001f\u007f]/.test(value) &&
    Buffer.byteLength(value) <= 107
  );
}

export async function readWorkspaceHostTarget(profile: string) {
  try {
    const saved = await readFile(
      path.join(profile, "workspace-host.json"),
      "utf8",
    );
    if (saved.length > 16384)
      throw new Error("Linux workspace target is too large");
    return workspaceHostSelection(JSON.parse(saved));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      "The saved Linux workspace configuration is invalid. Connect from Commands to replace it.",
    );
  }
}

export async function saveWorkspaceHostTarget(
  profile: string,
  target: WorkspaceHostSelection,
  signal?: AbortSignal,
) {
  const file = path.join(profile, "workspace-host.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(target) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  try {
    signal?.throwIfAborted();
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
