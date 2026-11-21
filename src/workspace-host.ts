import { lstat, mkdir } from "node:fs/promises";
import type { Socket } from "node:net";
import path from "node:path";
import { ApplicationOperations } from "./operations";
import type { AppState } from "./types";
import { startCommandSocket } from "./application/command-socket";
import {
  workspacePreparation,
  type PreparedWorkspace,
} from "./application/workspace-preparation";
import { serveWorkspaceReview } from "./remote-workspace/review-session";
import {
  maximumWorkspaceFrameBytes,
  type WorkspaceHostFrame,
} from "./remote-workspace/protocol";

function watchState(state: AppState): AppState {
  return {
    ...state,
    reviews: state.reviews?.map((review) => ({
      ...review,
      rounds: review.rounds.map((round) =>
        round.submission
          ? { ...round, submission: { ...round.submission, envelope: "" } }
          : round,
      ),
    })),
  };
}

async function main(): Promise<void> {
  const [directory, ...rest] = process.argv.slice(2);
  if (process.platform !== "linux")
    throw new Error("The workspace host runs on Linux");
  if (!directory || rest.length || !path.isAbsolute(directory))
    throw new Error("Usage: node dist/workspace-host.cjs /absolute/profile");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const profile = await lstat(directory);
  if (
    !profile.isDirectory() ||
    profile.uid !== process.getuid?.() ||
    (profile.mode & 0o077) !== 0
  )
    throw new Error("Choose a private workspace host profile you own");

  const socketPath = path.join(directory, "cod.sock");
  process.env.COD_DATA_DIR = directory;
  process.env.COD_SOCKET_PATH = socketPath;
  const runtime = new ApplicationOperations(directory);
  const watchers = new Set<Socket>();
  const send = (connection: Socket, frame: string) => {
    if (
      connection.writableLength + Buffer.byteLength(frame) >
      maximumWorkspaceFrameBytes
    )
      connection.destroy();
    else connection.write(frame);
  };
  const broadcast = (update: WorkspaceHostFrame) => {
    if (!watchers.size) return;
    const frame = JSON.stringify(update) + "\n";
    for (const connection of watchers) send(connection, frame);
  };
  let newestState: ReturnType<typeof runtime.snapshot>;
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  runtime.onDidChange = (value) => {
    if (!watchers.size) return;
    newestState = value;
    stateTimer ??= setTimeout(() => {
      stateTimer = undefined;
      broadcast({ type: "state", value: watchState(newestState) });
    }, 50);
    stateTimer.unref();
  };
  runtime.onDidTerminal = (value) => broadcast({ type: "terminal", value });
  let ready: Promise<void> | undefined;
  const requireReady = () => {
    if (!ready) throw new Error("The workspace host is starting");
    return ready;
  };
  const server = await startCommandSocket(
    socketPath,
    async (request) => {
      await requireReady();
      if (request?.op !== "workspace.prepare") return runtime.dispatch(request);
      const task = workspacePreparation(request, "linux");
      if (task.location !== "linux")
        throw new Error("This command runs on the Linux workspace host");

      const origin = task.conversation
        ? (
            (await runtime.dispatch({
              op: "context",
              conversation: task.conversation,
            })) as { workspace: { id: string } }
          ).workspace.id
        : undefined;
      const prepared = (await runtime.dispatch({
        op: "workspace.prepare",
        ...task,
      })) as PreparedWorkspace;
      if (origin && task.conversation) {
        await runtime.dispatch({
          op: "conversation.move",
          id: task.conversation,
          workspace: prepared.id,
          follow: true,
        });
        broadcast({
          type: "state",
          value: watchState(runtime.snapshot(true)),
          follow: {
            fromWorkspace: origin,
            workspace: prepared.id,
            conversation: task.conversation,
          },
        });
      } else {
        await runtime.dispatch({ op: "workspace.focus", id: prepared.id });
      }
      return { ...prepared, location: task.location };
    },
    async (connection, request) => {
      await requireReady();
      if (connection.destroyed) return;
      watchers.add(connection);
      connection.once("close", () => watchers.delete(connection));
      newestState = runtime.snapshot(true);
      send(
        connection,
        JSON.stringify({ type: "state", value: watchState(newestState) }) +
          "\n",
      );
      if (request.review === true)
        serveWorkspaceReview(
          connection,
          directory,
          (frame) => send(connection, JSON.stringify(frame) + "\n"),
          (operation) => runtime.dispatch(operation, true),
        );
    },
  );
  ready = runtime.initialize();

  const shutdown = async () => {
    for (const connection of watchers) connection.end();
    server.close();
    await ready;
    await runtime.shutdown();
  };
  try {
    await ready;
  } catch (error) {
    server.close();
    throw error;
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void shutdown().catch(report);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function report(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + "\n", () => process.exit(1));
});
