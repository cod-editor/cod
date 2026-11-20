import { connect } from "node:net";
import type { OperationRequest } from "./types";

export class CommandSocketError extends Error {
  constructor(
    message: string,
    readonly sent: boolean,
  ) {
    super(message);
  }
}

export async function invokeCommand(
  socketPath: string,
  request: OperationRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const connection = connect(socketPath);
    let sent = false;
    let input: string[] = [],
      bytes = 0,
      settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      input = [];
      connection.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const deadline = setTimeout(
      () => finish(new CommandSocketError("Cod operation timed out", sent)),
      30_000,
    );
    connection.setEncoding("utf8");
    connection.on("connect", () => {
      sent = true;
      connection.write(`${JSON.stringify(request)}\n`);
    });
    connection.on("data", (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 128 * 1024 * 1024) {
        finish(new CommandSocketError("Cod response exceeds 128 MiB", sent));
        return;
      }
      // Search only the new chunk. Flattening and rescanning every growing
      // prefix makes a large response quadratic in CPU and transient memory.
      const newline = chunk.indexOf("\n");
      input.push(newline < 0 ? chunk : chunk.slice(0, newline));
      if (newline < 0) return;
      try {
        const response: unknown = JSON.parse(input.join(""));
        if (!response || typeof response !== "object")
          throw new Error("Invalid response envelope");
        const value = response as Record<string, unknown>;
        if (value.ok === true && Object.hasOwn(value, "result"))
          finish(undefined, value.result);
        else if (value.ok === false && typeof value.error === "string")
          finish(new Error(value.error));
        else throw new Error("Invalid response envelope");
      } catch {
        finish(new CommandSocketError("Malformed Cod response", sent));
      }
    });
    connection.on("end", () =>
      finish(
        new CommandSocketError(
          "Cod connection ended before a complete response",
          sent,
        ),
      ),
    );
    connection.on("close", () =>
      finish(
        new CommandSocketError(
          "Cod connection closed before a complete response",
          sent,
        ),
      ),
    );
    connection.on("error", (error) =>
      finish(new CommandSocketError(error.message, sent)),
    );
  });
}
