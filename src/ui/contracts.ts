import type { OperationName } from "../command-catalog";
export type DesktopOperationName =
  | OperationName
  | "remote.target"
  | "remote.disconnect"
  | "remote.cancel"
  | "remote.reconnect-current";

export type Invoke = <T>(
  op: DesktopOperationName,
  values?: Record<string, unknown>,
  options?: { reportError?: boolean },
) => Promise<T>;

/** A decision after the latest accepted snapshot has actually rendered. */
export type WhenRendered = (
  check: () => boolean | undefined,
  signal: AbortSignal,
) => Promise<boolean>;
