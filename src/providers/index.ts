export { ProviderOptionError } from "./option-error.ts";
import { NativeAdapter } from "./adapter.ts";
import { ClaudeAdapter } from "./claude-adapter.ts";
import type { AdapterOptions, ProviderAdapter, ProviderId } from "./types.ts";
export type * from "./types.ts";
export const createCodexAdapter = (options: AdapterOptions): ProviderAdapter =>
  new NativeAdapter("codex", options);
export const createKimiAdapter = (options: AdapterOptions): ProviderAdapter =>
  new NativeAdapter("kimi", options);
export function createProviderAdapter(
  provider: ProviderId,
  options: AdapterOptions,
): ProviderAdapter {
  if (provider === "claude") return new ClaudeAdapter(options);
  return new NativeAdapter(provider, options);
}
