import { trustedReviewOperations } from "../command-catalog";
import type { AppState, OperationRequest, TerminalUiEvent } from "../types";

export const unconfirmedRemoteSend =
  "The Linux host did not confirm this message.";
export const maximumWorkspaceFrameBytes = 32 * 1024 * 1024;

export interface WorkspaceHostTarget {
  alias: string;
  socketPath: string;
  publicKey?: string;
}

export type WorkspaceHostFrame =
  | { type: "state"; value: AppState }
  | { type: "terminal"; value: TerminalUiEvent }
  | { type: "review-challenge"; value: string }
  | { type: "review-access"; value: boolean }
  | { type: "review-reply"; id: number; result?: unknown; error?: string };

const pairedDesktopOperations = new Set<string>([
  ...trustedReviewOperations,
  "review.show",
  "review.open-diff",
  "review.open-document",
  "review.inspect",
  "review.refresh",
  "review.submit",
  "review.deliver",
  "conversation.permission",
  "conversation.send",
  "conversation.check-steer",
]);

export function canUsePairedDesktop(request: OperationRequest): boolean {
  return pairedDesktopOperations.has(request?.op);
}

export interface RemoteWorkspaceView {
  alias: string;
  connected: boolean;
  reviewAccess: boolean;
  ids: string[];
}
