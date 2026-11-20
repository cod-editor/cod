#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { invokeCommand } from "./command-client";
import { defaultSocketPath } from "./paths";
import { help, parseArguments } from "./command-catalog";
import type { OperationRequest, ReviewSummary } from "./types";

const invoke = (request: OperationRequest) =>
  invokeCommand(defaultSocketPath(), request);

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
        })) as ReviewSummary;
        const round = summary.rounds.find((r) => r.id === request.round);
        if (!round) throw new Error("Unknown review round");
        if (round.submission) {
          process.stdout.write(JSON.stringify(round.submission) + "\n");
          return;
        }
        if (round.status === "cancelled") {
          process.stdout.write(
            JSON.stringify({
              status: "cancelled",
              reviewId: request.id,
              roundId: round.id,
            }) + "\n",
          );
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
