import { execFile, spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { CommandSocketError, invokeCommand } from "../command-client";
import type { AppState, OperationRequest } from "../types";
import {
  canUsePairedDesktop,
  maximumWorkspaceFrameBytes,
  unconfirmedRemoteSend,
  type WorkspaceHostFrame,
  type WorkspaceHostSelection,
  type WorkspaceHostTarget,
} from "./protocol";
import { signWorkspaceReview } from "./review-signature";
import { validWorkspaceSocket } from "./target";

const sshOptions = [
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
  "ConnectTimeout=10",
];

async function discoverWorkspaceSocket(
  alias: string,
  signal?: AbortSignal,
): Promise<string> {
  let output: string;
  try {
    const result = await promisify(execFile)(
      "/usr/bin/ssh",
      [
        ...sshOptions,
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "RemoteCommand=none",
        alias,
        'exec "$HOME/.local/bin/cod-workspace-host" endpoint',
      ],
      { signal, timeout: 12_000, maxBuffer: 4_096, killSignal: "SIGKILL" },
    );
    output = result.stdout;
  } catch (error) {
    signal?.throwIfAborted();
    const failure = error as { code?: unknown; stderr?: string };
    if (failure.code === 127)
      throw new Error(
        `Set up the Cod workspace host on "${alias}" first. See the Linux workspace host setup in the Cod guide.`,
      );
    const diagnostic = failure.stderr?.trim().slice(-2_048);
    throw new Error(
      diagnostic ||
        `Could not discover the Cod workspace host on "${alias}". Check SSH access and the host service.`,
    );
  }
  let response: { socketPath?: unknown } | null;
  try {
    response = JSON.parse(output);
  } catch {
    response = null;
  }
  if (!validWorkspaceSocket(response?.socketPath))
    throw new Error("The Linux workspace host returned an invalid endpoint");
  return response.socketPath;
}

export interface HostLink {
  selection: WorkspaceHostSelection;
  state: AppState;
  connected: boolean;
  reviewAccess: boolean;
  invoke(request: OperationRequest): Promise<unknown>;
  close(): void;
}

export async function attachWorkspaceHost(
  selection: WorkspaceHostSelection,
  update: (link: HostLink, frame?: WorkspaceHostFrame) => void,
  signal?: AbortSignal,
): Promise<HostLink> {
  signal?.throwIfAborted();
  const target: WorkspaceHostTarget = {
    ...selection,
    socketPath:
      selection.socketPath ??
      (await discoverWorkspaceSocket(selection.alias, signal)),
  };
  signal?.throwIfAborted();
  // A short private directory also leaves room in the Unix socket path limit.
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-ssh-"));
  const socketPath = path.join(directory, "s");
  const ssh = spawn(
    "/usr/bin/ssh",
    [
      "-N",
      ...sshOptions,
      "-o",
      "ExitOnForwardFailure=yes",
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
  let pendingReview:
    | {
        id: number;
        complete(
          frame: Extract<WorkspaceHostFrame, { type: "review-reply" }>,
        ): void;
        unconfirmed(): void;
      }
    | undefined;
  const close = () => {
    if (stopped) return;
    stopped = true;
    pendingReview?.unconfirmed();
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
      let nextReviewId = 0;
      let reviewQueue: Promise<unknown> = Promise.resolve();
      let reviewNegotiation: ReturnType<typeof setTimeout> | undefined;
      const accept = () => {
        if (link && rejectInitial) {
          clearTimeout(reviewNegotiation);
          rejectInitial = undefined;
          resolve(link);
        }
      };
      const invokeReview = (request: OperationRequest) => {
        const next = reviewQueue
          .catch(() => undefined)
          .then(() => {
            if (stopped || !link?.connected)
              throw new Error("Reconnect to the Linux workspace first");
            if (!link.reviewAccess)
              throw new Error(
                "Pair this desktop to use remote review and approvals",
              );
            return new Promise<unknown>((resolve, reject) => {
              const id = ++nextReviewId;
              const unconfirmed = () => {
                clearTimeout(deadline);
                pendingReview = undefined;
                reject(
                  new Error(
                    request.op === "conversation.send"
                      ? unconfirmedRemoteSend
                      : "The host did not confirm this operation. Check the host state before retrying.",
                  ),
                );
              };
              const deadline = setTimeout(() => {
                unconfirmed();
                fail(
                  "The Linux workspace stopped responding to review requests",
                );
              }, 30_000);
              pendingReview = {
                id,
                unconfirmed,
                complete(frame) {
                  clearTimeout(deadline);
                  pendingReview = undefined;
                  if (typeof frame.error === "string")
                    reject(new Error(frame.error));
                  else resolve(frame.result);
                },
              };
              connection.write(
                JSON.stringify({ type: "review-command", id, request }) + "\n",
              );
            });
          });
        reviewQueue = next;
        return next;
      };
      connection.on("connect", () =>
        connection.write(
          JSON.stringify({
            op: "workspace.watch",
            ...(target.publicKey ? { review: true } : {}),
          }) + "\n",
        ),
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
              link = {
                selection,
                state: frame.value,
                connected: true,
                reviewAccess: false,
                close,
                async invoke(request) {
                  if (
                    canUsePairedDesktop(request) &&
                    (request.op !== "conversation.send" || this.reviewAccess)
                  )
                    return invokeReview(request);
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
              if (target.publicKey)
                reviewNegotiation = setTimeout(accept, 9000);
              else accept();
            }
          } else if (frame?.type === "terminal" && link) update(link, frame);
          else if (
            frame?.type === "review-challenge" &&
            link &&
            target.publicKey &&
            rejectInitial
          ) {
            void signWorkspaceReview(target.publicKey, frame.value).then(
              (signature) => {
                if (!stopped && rejectInitial)
                  connection.write(
                    JSON.stringify({ type: "review-proof", signature }) + "\n",
                  );
              },
              accept,
            );
          } else if (frame?.type === "review-access" && link) {
            link.reviewAccess = frame.value === true;
            accept();
            update(link, frame);
          } else if (
            frame?.type === "review-reply" &&
            pendingReview?.id === frame.id
          ) {
            pendingReview.complete(frame);
          } else {
            fail("This socket is not a compatible Cod workspace host");
            return;
          }
        }
      });
      connection.once("error", () => fail("The workspace connection failed"));
      connection.once("close", () => {
        clearTimeout(timeout);
        clearTimeout(reviewNegotiation);
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
