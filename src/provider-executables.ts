import { access } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderId } from "./providers/types";

function overrideArguments(provider: ProviderId): string[] | undefined {
  const value = process.env[`COD_${provider.toUpperCase()}_ARGS`];
  if (!value) return undefined;
  try {
    const args = JSON.parse(value) as unknown;
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
      throw new Error("not an array");
    }
    return args;
  } catch {
    throw new Error(
      `COD_${provider.toUpperCase()}_ARGS must be a JSON array of strings`,
    );
  }
}

async function executableAt(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveProviderExecutable(
  provider: ProviderId,
): Promise<{ executable: string; args?: string[] }> {
  const prefix = `COD_${provider.toUpperCase()}`;
  const override = process.env[`${prefix}_EXECUTABLE`];
  const args = overrideArguments(provider);
  if (override) return { executable: override, args };

  const installed =
    provider === "kimi"
      ? [
          path.join(os.homedir(), ".kimi-code", "bin", "kimi"),
          "/opt/homebrew/bin/kimi",
          "/usr/local/bin/kimi",
        ]
      : [
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
          path.join(os.homedir(), ".local", "bin", "codex"),
        ];
  const onPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, provider));
  for (const candidate of [...onPath, ...installed]) {
    if (await executableAt(candidate)) return { executable: candidate, args };
  }
  throw new Error(
    `${provider} CLI was not found on PATH or in its standard install location. Install it or set ${prefix}_EXECUTABLE.`,
  );
}
