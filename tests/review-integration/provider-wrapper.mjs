// Transparent wrapper around the shared invented native-protocol fixture.
// It disconnects only after native history has persisted a specially marked turn.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
const [provider, recording] = process.argv.slice(2);
const fixture = fileURLToPath(
  new URL("../e2e/helpers/chat-fixture/provider.mjs", import.meta.url),
);
const child = spawn(process.execPath, [fixture, provider, recording], {
  stdio: ["pipe", "pipe", "pipe"],
});
let disconnect = false,
  stopping = false;
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    if (
      ["turn/start", "session/prompt"].includes(message.method) &&
      JSON.stringify(message.params).includes("[review-accepted-disconnect]")
    )
      disconnect = true;
    child.stdin.write(line + "\n");
  })
  .on("close", () => child.stdin.end());
createInterface({ input: child.stdout }).on("line", (line) => {
  process.stdout.write(line + "\n");
  const message = JSON.parse(line);
  if (
    disconnect &&
    !stopping &&
    (message.result?.turn?.id || message.method === "session/update")
  ) {
    stopping = true;
    child.kill("SIGTERM");
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("error", () => process.exit(24));
child.on("exit", (code) => process.exit(stopping ? 23 : (code ?? 1)));
process.on("SIGTERM", () => child.kill("SIGTERM"));
