import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { ApplicationOperations } from "./operations";
import { startCommandSocket } from "./application/command-socket";

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
  let ready: Promise<void> | undefined;
  const server = await startCommandSocket(socketPath, async (request) => {
    if (!ready) throw new Error("The workspace host is starting");
    await ready;
    return runtime.dispatch(request);
  });
  ready = runtime.initialize();

  const shutdown = async () => {
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
