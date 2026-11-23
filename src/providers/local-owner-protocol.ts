import { createHash } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { ProviderAdapter, ProviderEvent } from "./types";
import type { ProviderOptionError } from "./option-error";

export const ownerProtocol = 1;
export const ownerBuildMismatchExit = 2;
export const ownerUnavailable =
  "The detached chat owner is no longer available";
export const maximumOwnerFrame = 8 * 1024 * 1024;

export const ownerMethods = [
  "create",
  "resume",
  "discover",
  "inspect",
  "earlierHistory",
  "historyOutput",
  "getOptions",
  "getDraftOptions",
  "setOption",
  "resolveSkills",
  "send",
  "steer",
  "findSteeredItem",
  "sendToolResult",
  "permission",
  "cancel",
] as const satisfies ReadonlyArray<keyof ProviderAdapter>;
export type OwnerMethod = (typeof ownerMethods)[number];

export interface LocalOwnerCursor {
  generation: string;
  sequence: number;
  build?: string;
}

export interface LocalOwnerState {
  nativeId: string | null;
  activeTurnId?: string;
  selection?: ReturnType<ProviderAdapter["getSelection"]>;
  capabilities: ProviderAdapter["capabilities"];
}

export type LocalOwnerFrame =
  | {
      type: "ready";
      protocol: number;
      cursor: LocalOwnerCursor;
      through: number;
      state: LocalOwnerState;
    }
  | {
      type: "event";
      sequence: number;
      at: number;
      event: ProviderEvent;
      activeTurnId?: string;
    };

export type LocalOwnerReply =
  | { ok: true; value: unknown; state: LocalOwnerState; through: number }
  | { ok: false; message: string; optionCode?: ProviderOptionError["code"] };

export function localOwnerDirectory(profile: string): string {
  const key = createHash("sha256")
    .update(path.resolve(profile))
    .digest("hex")
    .slice(0, 24);
  return path.join("/tmp", `cod-owner-${process.getuid?.()}-${key}`);
}

async function privateOwnerDirectory(
  profile: string,
  create = false,
): Promise<string> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Detached chat sessions require macOS or Linux");
  const directory = localOwnerDirectory(profile);
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    throw new Error("Detached chat session directory is not private");
  return directory;
}

export async function localOwnerSocket(
  profile: string,
  build?: string,
  create = false,
): Promise<string> {
  if (build !== undefined && !/^[a-f0-9]{24}$/.test(build))
    throw new Error("Invalid detached chat owner build");
  const directory = await privateOwnerDirectory(profile, create);
  return path.join(directory, build ? `control-${build}` : "control");
}

export async function localOwnerSockets(profile: string): Promise<string[]> {
  const directory = await privateOwnerDirectory(profile);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isSocket() && /^(control|control-[a-f0-9]{24})$/.test(entry.name),
    )
    .map((entry) => path.join(directory, entry.name));
}
