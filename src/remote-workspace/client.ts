import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CommandSocketError, invokeCommand } from "../command-client";
import type { AppState, OperationRequest } from "../types";
import {
  maximumWorkspaceFrameBytes,
  unconfirmedRemoteSend,
  type WorkspaceHostFrame,
  type WorkspaceHostTarget,
} from "./protocol";

function validTarget(target: WorkspaceHostTarget): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(target.alias))
    throw new Error("Enter an OpenSSH host alias");
  if (
    !path.posix.isAbsolute(target.socketPath) ||
    /[:\u0000-\u001f\u007f]/.test(target.socketPath) ||
    Buffer.byteLength(target.socketPath) > 107
  )
    throw new Error("Enter a valid absolute Linux workspace socket path");
}

export interface HostLink {
  target: WorkspaceHostTarget;
  state: AppState;
  connected: boolean;
  invoke(request: OperationRequest): Promise<unknown>;
  close(): void;
}

export async function attachWorkspaceHost(
  target: WorkspaceHostTarget,
  update: (link: HostLink, frame?: WorkspaceHostFrame) => void,
  signal?: AbortSignal,
): Promise<HostLink> {
  validTarget(target);
  signal?.throwIfAborted();
  // A short private directory also leaves room in the Unix socket path limit.
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-ssh-"));
  const socketPath = path.join(directory, "s");
  const ssh = spawn(
    "/usr/bin/ssh",
    [
      "-N",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ForwardX11=no",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "PermitLocalCommand=no",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      "-L",
      socketPath + ":" + target.socketPath,
      target.alias,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let diagnostics = "";
  ssh.stderr.setEncoding("utf8").on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-2048);
  });
  let stream: Socket | undefined;
  let link: HostLink | undefined;
  let stopped = false;
  let rejectInitial: ((error: Error) => void) | undefined;
  const close = () => {
    if (stopped) return;
    stopped = true;
    stream?.destroy();
    if (ssh.pid && ssh.exitCode === null && ssh.signalCode === null)
      ssh.kill("SIGTERM");
    void rm(directory, { recursive: true, force: true }).catch(() => {});
  };
  const fail = (message: string) => {
    if (stopped) return;
    close();
    rejectInitial?.(new Error(message));
    if (link) {
      link.connected = false;
      update(link);
    }
  };
  const cancel = () => fail("Connection canceled");
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  ssh.once("error", (error) => fail("Cannot start OpenSSH: " + error.message));
  ssh.once("close", () =>
    fail(diagnostics.trim() || "The SSH connection closed"),
  );

  const deadline = Date.now() + 12000;
  try {
    while (true) {
      signal?.throwIfAborted();
      if (stopped)
        throw new Error(diagnostics.trim() || "SSH connection failed");
      const ready = await lstat(socketPath)
        .then((entry) => entry.isSocket())
        .catch((error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
      signal?.throwIfAborted();
      if (stopped)
        throw new Error(diagnostics.trim() || "SSH connection failed");
      if (ready) break;
      if (Date.now() >= deadline)
        throw new Error("Timed out connecting to the Linux workspace");
      await delay(40);
    }
    return await new Promise<HostLink>((resolve, reject) => {
      rejectInitial = reject;
      const timeout = setTimeout(
        () => fail("The Linux workspace did not send its initial state"),
        Math.max(1, deadline - Date.now()),
      );
      const connection = connect(socketPath);
      stream = connection;
      connection.setEncoding("utf8");
      let chunks: string[] = [];
      let bytes = 0;
      connection.on("connect", () =>
        connection.write('{"op":"workspace.watch"}\n'),
      );
      connection.on("data", (chunk: string) => {
        for (let start = 0; start < chunk.length;) {
          const end = chunk.indexOf("\n", start);
          const part = chunk.slice(start, end < 0 ? undefined : end);
          bytes += Buffer.byteLength(part);
          if (bytes > maximumWorkspaceFrameBytes) {
            fail("The remote workspace state exceeds the allowed size");
            return;
          }
          chunks.push(part);
          if (end < 0) return;
          let frame: WorkspaceHostFrame;
          try {
            frame = JSON.parse(chunks.join("")) as WorkspaceHostFrame;
          } catch {
            fail("The Linux workspace sent an invalid state frame");
            return;
          }
          start = end + 1;
          chunks = [];
          bytes = 0;
          if (
            frame?.type === "state" &&
            Array.isArray(frame.value?.workspaces)
          ) {
            if (link) {
              link.state = frame.value;
              update(link, frame);
            } else {
              clearTimeout(timeout);
              rejectInitial = undefined;
              link = {
                target,
                state: frame.value,
                connected: true,
                close,
                async invoke(request) {
                  if (!this.connected || stopped)
                    throw new Error("Reconnect to the Linux workspace first");
                  try {
                    return await invokeCommand(socketPath, request);
                  } catch (error) {
                    if (error instanceof CommandSocketError && error.sent)
                      throw new Error(
                        request.op === "conversation.send"
                          ? unconfirmedRemoteSend
                          : "The host did not confirm this operation. Check its state before retrying.",
                      );
                    throw error;
                  }
                },
              };
              resolve(link);
            }
          } else if (frame?.type === "terminal" && link) update(link, frame);
          else {
            fail("This socket is not a compatible Cod workspace host");
            return;
          }
        }
      });
      connection.once("error", () => fail("The workspace connection failed"));
      connection.once("close", () => {
        clearTimeout(timeout);
        fail("The workspace connection closed");
      });
    });
  } catch (error) {
    close();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
