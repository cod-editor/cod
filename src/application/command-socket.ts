import { chmod, lstat, unlink } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import type { OperationRequest } from "../types";

async function prepareSocket(socketPath: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const details = await lstat(socketPath);
    if (!details.isSocket())
      throw new Error(`Socket path is not a socket: ${socketPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const live = await new Promise<boolean>((resolve, reject) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.end();
      resolve(true);
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
        resolve(false);
      else reject(error);
    });
  });
  if (live)
    throw new Error("Another Cod instance already controls this socket");
  await unlink(socketPath);
}

export async function startCommandSocket(
  socketPath: string,
  dispatch: (request: OperationRequest) => Promise<unknown>,
): Promise<Server> {
  await prepareSocket(socketPath);
  const server = createServer((connection) => {
    connection.on("error", () => undefined);
    connection.setEncoding("utf8");
    let input: string[] = [];
    let bytes = 0;
    let received = false;
    connection.on("data", (chunk: string) => {
      if (received) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 32 * 1024 * 1024) {
        received = true;
        input = [];
        connection.end(
          `${JSON.stringify({ ok: false, error: "Request too large" })}\n`,
        );
        return;
      }
      const newline = chunk.indexOf("\n");
      input.push(newline < 0 ? chunk : chunk.slice(0, newline));
      if (newline < 0) return;
      received = true;
      const line = input.join("");
      input = [];
      void (async () => {
        try {
          const request = JSON.parse(line) as OperationRequest;
          const result = await dispatch(request);
          connection.end(`${JSON.stringify({ ok: true, result })}\n`);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          connection.end(`${JSON.stringify({ ok: false, error: message })}\n`);
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      server.on("error", (error) => console.error(error));
      resolve();
    });
  });
  try {
    if (process.platform !== "win32") await chmod(socketPath, 0o600);
    return server;
  } catch (error) {
    server.close();
    throw error;
  }
}
