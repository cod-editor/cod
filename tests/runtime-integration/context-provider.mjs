// A transparent wrapper around the existing native fixture. Only MCP registration is added.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
const [provider, recording] = process.argv.slice(2);
const record = (event, data = {}) =>
  appendFileSync(
    recording,
    JSON.stringify({ event, provider, pid: process.pid, ...data }) + "\n",
  );
const native = spawn(
  process.execPath,
  [
    fileURLToPath(
      new URL("../e2e/helpers/chat-fixture/provider.mjs", import.meta.url),
    ),
    provider,
    recording,
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);
native.stdout.pipe(process.stdout);
native.stderr.pipe(process.stderr);
native.stdin.on("error", () => {});
const servers = [];
function stop() {
  for (const child of servers) child.kill("SIGTERM");
  native.kill("SIGTERM");
}
function rpc(child, id, method, params) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Fixture MCP timeout: ${method}`));
    }, 5000);
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"),
          line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          cleanup();
          reject(new Error("Non-protocol MCP stdout"));
          return;
        }
        if (message.id === id) {
          cleanup();
          message.error
            ? reject(new Error(JSON.stringify(message.error)))
            : resolve(message.result);
        }
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error("MCP exited during fixture handshake"));
    };
    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    }
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });
}
async function observeContext(message) {
  const p = message.params ?? {};
  let descriptor;
  if (provider === "codex") {
    const entries = Object.entries(p.config ?? {}).filter(([key]) =>
      key.startsWith("mcp_servers."),
    );
    if (entries.length === 1)
      descriptor = {
        name: entries[0][0].slice("mcp_servers.".length),
        ...entries[0][1],
      };
  } else if (p.mcpServers?.length === 1) {
    const raw = p.mcpServers[0];
    descriptor = {
      ...raw,
      env: Object.fromEntries(raw.env.map(({ name, value }) => [name, value])),
    };
  }
  record("context-descriptor", {
    method: message.method,
    params: p,
    descriptor: descriptor ?? null,
    providerNodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  });
  if (!descriptor) return;
  const child = spawn(descriptor.command, descriptor.args, {
    env: { ...process.env, ...descriptor.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  servers.push(child);
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  child.on("error", (error) => {
    record("context-child-error", { message: error.message });
  });
  await rpc(child, 1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "cod-fixture", version: "1" },
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  const listing = await rpc(child, 2, "tools/list", {});
  record("context-registered", {
    method: message.method,
    serverName: descriptor.name,
    childPid: child.pid,
    tools: listing.tools.map((tool) => tool.name),
  });
}
let queue = Promise.resolve();
createInterface({ input: process.stdin })
  .on("line", (line) => {
    queue = queue
      .then(async () => {
        const message = JSON.parse(line);
        if (
          [
            "thread/start",
            "thread/resume",
            "session/new",
            "session/load",
          ].includes(message.method)
        )
          await observeContext(message);
        native.stdin.write(line + "\n");
      })
      .catch((error) => {
        process.stderr.write(error.message + "\n");
        stop();
        process.exitCode = 1;
      });
  })
  .on("close", stop);
native.on("exit", (code) => {
  stop();
  process.exitCode = code ?? 1;
  process.stdin.pause();
});
