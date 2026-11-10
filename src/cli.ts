#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { defaultSocketPath } from "./paths";
import { help, parseArguments } from "./command-catalog";
import type { OperationRequest } from "./types";

async function invoke(request: OperationRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const connection = connect(defaultSocketPath());
    let input = "",
      bytes = 0,
      settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      connection.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const deadline = setTimeout(
      () => finish(new Error("Cod operation timed out")),
      30_000,
    );
    connection.setEncoding("utf8");
    connection.on("connect", () =>
      connection.write(`${JSON.stringify(request)}\n`),
    );
    connection.on("data", (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 128 * 1024 * 1024) {
        finish(new Error("Cod response exceeds 128 MiB"));
        return;
      }
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        const response: unknown = JSON.parse(input.slice(0, newline));
        if (!response || typeof response !== "object")
          throw new Error("Invalid response envelope");
        const value = response as Record<string, unknown>;
        if (value.ok === true && Object.hasOwn(value, "result"))
          finish(undefined, value.result);
        else if (value.ok === false && typeof value.error === "string")
          finish(new Error(value.error));
        else throw new Error("Invalid response envelope");
      } catch {
        finish(new Error("Malformed Cod response"));
      }
    });
    connection.on("end", () =>
      finish(new Error("Cod connection ended before a complete response")),
    );
    connection.on("close", () =>
      finish(new Error("Cod connection closed before a complete response")),
    );
    connection.on("error", (error) => finish(error));
  });
}
async function main(): Promise<void> {
  try {
    const request = parseArguments(process.argv.slice(2));
    if (!request) {
      process.stdout.write(help);
      return;
    }
    if (typeof request.imagesFile === "string") {
      if (request.images !== undefined)
        throw new Error("Use images or images-file, not both");
      request.images = JSON.parse(await readFile(request.imagesFile, "utf8"));
      delete request.imagesFile;
    }
    if (request.op === "context" && request.conversation === undefined) {
      if (!process.env.COD_CONVERSATION_ID)
        throw new Error(
          "Use --conversation ID outside an app-managed conversation",
        );
      request.conversation = process.env.COD_CONVERSATION_ID;
    }
    if (request.op === "review.wait") {
      const timeout =
        request.timeoutMs === undefined ? 30000 : Number(request.timeoutMs);
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400000)
        throw new Error("timeout-ms must be 1..86400000");
      const deadline = Date.now() + timeout;
      do {
        const summary = (await invoke({
          op: "review.inspect",
          id: request.id,
        })) as { rounds: Array<{ id: string; submission?: unknown }> };
        const round = summary.rounds.find((r) => r.id === request.round);
        if (!round) throw new Error("Unknown review round");
        if (round.submission) {
          process.stdout.write(JSON.stringify(round.submission) + "\n");
          return;
        }
        if (Date.now() >= deadline) {
          process.exitCode = 2;
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(100, deadline - Date.now())),
        );
      } while (true);
    }
    process.stdout.write(`${JSON.stringify(await invoke(request))}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  }
}
void main();
