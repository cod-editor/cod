import type { OperationRequest } from "../types";
import type { ProviderId } from "../providers";
export function requiredString(request: OperationRequest, key: string): string {
  const value = request[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

export function requiredName(request: OperationRequest): string {
  const name = requiredString(request, "name").trim();
  if (!name) throw new Error("name must not be blank");
  return name;
}

export function providerId(request: OperationRequest): ProviderId {
  const provider = requiredString(request, "provider");
  if (provider !== "codex" && provider !== "kimi") {
    throw new Error(
      "provider must be codex or kimi; Claude is not implemented",
    );
  }
  return provider;
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
