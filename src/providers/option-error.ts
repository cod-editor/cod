/** Stable safe error surface for app/CLI option controls. Never carries native diagnostics. */
export class ProviderOptionError extends Error {
  readonly code: "not-ready" | "busy" | "invalid-selection" | "unavailable";
  constructor(code: ProviderOptionError["code"], message: string) {
    super(message);
    this.name = "ProviderOptionError";
    this.code = code;
  }
}
