import path from "node:path";
import type { OperationRequest } from "../types";
import { requiredName, requiredString } from "./request";

export function workspacePreparation(
  request: OperationRequest,
  defaultLocation?: "local" | "linux",
) {
  const location =
    request.location === undefined ? defaultLocation : request.location;
  if (location !== "local" && location !== "linux")
    throw new Error("location must be local or linux");
  const name = requiredName(request);
  const folders = request.folders === undefined ? [] : request.folders;
  if (
    !Array.isArray(folders) ||
    !folders.every(
      (folder) => typeof folder === "string" && path.isAbsolute(folder),
    )
  )
    throw new Error(
      "folders must be an array of absolute paths on the selected host",
    );
  const conversation =
    request.conversation === undefined
      ? undefined
      : requiredString(request, "conversation");
  return {
    location,
    name,
    folders: folders as string[],
    conversation,
  } as const;
}

export interface PreparedWorkspace {
  id: string;
  folders: string[];
}

export interface WorkspaceFollow {
  fromWorkspace: string;
  workspace: string;
  conversation: string;
}
