export { ProviderOptionError } from "./option-error.ts";
import { NativeAdapter } from "./adapter.ts";
import type { AdapterOptions, ProviderAdapter } from "./types.ts";
export type * from "./types.ts";
export const createCodexAdapter = (options: AdapterOptions): ProviderAdapter =>
  new NativeAdapter("codex", options);
export const createKimiAdapter = (options: AdapterOptions): ProviderAdapter =>
  new NativeAdapter("kimi", options);
export const claudeAvailability = {
  available: false,
  reason:
    "Native adapter not implemented; live protocol validation is blocked by subscription access. No raw model fallback.",
} as const;
