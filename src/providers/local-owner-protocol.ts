import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ProviderAdapter, ProviderEvent } from "./types";
import type { ProviderOptionError } from "./option-error";

export const ownerProtocol = 1;
export const maximumOwnerFrame = 8 * 1024 * 1024;

export const ownerMethods = [
  "create",
  "resume",
  "discover",
  "inspect",
  "earlierHistory",
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

export async function localOwnerSocket(
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
  return path.join(directory, "control");
}
