import type { OperationName } from "../command-catalog";
/** Renderer operations use the same application commands as codctl. */
export type Invoke = <T>(
  op: OperationName,
  values?: Record<string, unknown>,
  options?: { reportError?: boolean },
) => Promise<T>;
