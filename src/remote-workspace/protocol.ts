import type { AppState, TerminalUiEvent } from "../types";

export const maximumWorkspaceFrameBytes = 32 * 1024 * 1024;

export interface WorkspaceHostTarget {
  alias: string;
  socketPath: string;
}

export type WorkspaceHostFrame =
  | { type: "state"; value: AppState }
  | { type: "terminal"; value: TerminalUiEvent };

export interface RemoteWorkspaceView {
  alias: string;
  connected: boolean;
  ids: string[];
}
