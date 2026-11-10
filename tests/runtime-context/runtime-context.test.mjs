import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let temporary, bundle;
before(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "cod-context-tests-"));
  bundle = path.join(temporary, "fixture.cjs");
  await build({
    entryPoints: [path.join(here, "fixture.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
  });
});
after(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});
function source() {
  return {
    capabilities: {
      operations: ["state", "capabilities", "workspace.focus"],
      fixtureRevision: "revision-one",
    },
    state: {
      activeWorkspaceId: "unrelated-workspace",
      workspaces: [
        {
          id: "bound-workspace",
          name: "Bound 🌱 fixture",
          folders: ["/invented/alpha", "/invented/beta"],
          activePaneId: "pane-bound",
          panes: [{ id: "pane-bound", private: "UNEXPECTED_PANE_PAYLOAD" }],
        },
        {
          id: "unrelated-workspace",
          name: "PRIVATE_OTHER_WORKSPACE",
          folders: ["/private/unrelated"],
        },
      ],
      conversations: [
        {
          id: "bound-conversation",
          workspaceId: "bound-workspace",
          provider: "codex",
          nativeId: "invented-native-id",
          cwd: "/invented/alpha",
          status: "waiting",
          messages: [{ text: "PRIVATE_BOUND_TRANSCRIPT" }],
          pendingPermissions: [{ details: "PRIVATE_APPROVAL" }],
        },
        {
          id: "unrelated-conversation",
          workspaceId: "unrelated-workspace",
          provider: "kimi",
          nativeId: "PRIVATE_OTHER_NATIVE_ID",
          messages: [{ text: "PRIVATE_OTHER_TRANSCRIPT" }],
        },
      ],
    },
  };
}
async function open(t, config = source(), mode) {
  const directory = await mkdtemp(path.join(temporary, "child-"));
  const configuration = path.join(directory, "config.json"),
    audit = path.join(directory, "audit.jsonl");
  await writeFile(configuration, JSON.stringify(config));
  await writeFile(audit, "");
  const child = spawn(
    process.execPath,
    [bundle, configuration, audit, ...(mode ? [mode] : [])],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, INVENTED_PRIVATE_ENV: "PRIVATE_ENV_SENTINEL" },
    },
  );
  const lines = [],
    invalid = [];
  let buffer = "",
    stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, "2.0");
        lines.push(message);
      } catch {
        invalid.push(line);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const childError = new Promise((_, reject) => child.once("error", reject));
  child.stdin.on("error", () => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await Promise.race([exited, pause(1000)]);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
    await exited;
    assert.deepEqual(invalid, [], "stdout contained non-protocol output");
    assert.equal(buffer, "", "stdout ended with partial JSON");
  });
  async function response(id) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const found = lines.find((message) => message.id === id);
      if (found) return found;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Server exited before response ${id}: ${stderr}`);
      await pause(10);
    }
    throw new Error(`No response for ${id}`);
  }
  const send = (message) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const request = async (id, method, params) => {
    send({ id, method, ...(params === undefined ? {} : { params }) });
    return response(id);
  };
  const initialize = async () => {
    const result = await request("init", "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "invented-qa", version: "1" },
    });
    send({ method: "notifications/initialized" });
    return result;
  };
  return {
    child,
    lines,
    invalid,
    stderr: () => stderr,
    request,
    response,
    send,
    initialize,
    exited: Promise.race([exited, childError]),
    configure: (value) => writeFile(configuration, JSON.stringify(value)),
    audit: async () =>
      (await readFile(audit, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}
function toolJson(message) {
  assert(!message.error, JSON.stringify(message.error));
  assert.notEqual(message.result.isError, true);
  assert(Array.isArray(message.result.content));
  return JSON.parse(
    message.result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(""),
  );
}
function structuredFailure(message) {
  assert(
    (message.error && Number.isInteger(message.error.code)) ||
      message.result?.isError === true,
    "Expected structured protocol/tool error",
  );
}

test("AC1 stdio initialize, ping and exactly two meaningful tools without unsolicited stdout", async (t) => {
  const server = await open(t);
  const initialized = await server.initialize();
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  assert(initialized.result.serverInfo.name);
  assert(initialized.result.capabilities.tools);
  for (const unsupported of [
    "resources",
    "prompts",
    "logging",
    "subscriptions",
  ])
    assert.equal(initialized.result.capabilities[unsupported], undefined);
  assert.deepEqual((await server.request(2, "ping")).result, {});
  const listing = await server.request(3, "tools/list");
  assert.deepEqual(listing.result.tools.map((tool) => tool.name).sort(), [
    "cod_context",
    "cod_help",
  ]);
  for (const tool of listing.result.tools) {
    assert.match(tool.description, /Cod|CLI/);
    assert.match(
      tool.description,
      /workspace|conversation|target|capabilit|operation/i,
    );
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.properties ?? {}, {});
  }
  const before = server.lines.length;
  server.send({ method: "notifications/initialized" });
  server.send({ method: "notifications/invented" });
  await pause(100);
  assert.equal(server.lines.length, before);
});

test("AC2 bound context ignores active workspace and excludes transcripts, unrelated state and environment", async (t) => {
  const server = await open(t);
  await server.initialize();
  const response = await server.request(1, "tools/call", {
    name: "cod_context",
    arguments: {},
  });
  const context = toolJson(response);
  assert.deepEqual(context.workspace, {
    id: "bound-workspace",
    name: "Bound 🌱 fixture",
    folders: ["/invented/alpha", "/invented/beta"],
    activePaneId: "pane-bound",
  });
  assert.deepEqual(context.conversation, {
    id: "bound-conversation",
    provider: "codex",
    nativeId: "invented-native-id",
    cwd: "/invented/alpha",
    status: "waiting",
  });
  assert.equal(context.cliCommand, "node /invented/cod/dist/cli.cjs");
  assert.match(context.helpText, /CURRENT_FIXTURE_HELP/);
  assert.doesNotMatch(
    JSON.stringify(response),
    /PRIVATE_|unrelated-workspace|UNEXPECTED_PANE_PAYLOAD/,
  );
  assert(
    (await server.audit()).every((entry) =>
      ["state", "capabilities"].includes(entry.op),
    ),
  );
});

test("AC3 help follows injected current capabilities rather than a phantom catalog", async (t) => {
  const config = source(),
    server = await open(t, config);
  await server.initialize();
  const first = toolJson(
    await server.request(1, "tools/call", { name: "cod_help", arguments: {} }),
  );
  assert.deepEqual(first.capabilities, config.capabilities);
  assert.match(first.helpText, /CURRENT_FIXTURE_HELP/);
  config.capabilities = {
    operations: ["state"],
    fixtureRevision: "revision-two",
  };
  await server.configure(config);
  const second = toolJson(
    await server.request(2, "tools/call", { name: "cod_help", arguments: {} }),
  );
  assert.deepEqual(second.capabilities, config.capabilities);
  assert.equal(second.cliCommand, first.cliCommand);
  assert.equal(second.helpText, first.helpText);
});

test("AC4 malformed requests, invalid arguments and target/operation errors stay isolated", async (t) => {
  const config = source(),
    server = await open(t, config);
  await server.initialize();
  server.child.stdin.write("{not JSON}\n");
  await pause(50);
  assert(
    server.lines.some(
      (message) => message.id === null && message.error?.code === -32700,
    ),
  );
  server.child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: "invalid-envelope", params: {} }) +
      "\n",
  );
  assert.equal((await server.response("invalid-envelope")).error.code, -32600);
  const unknown = await server.request(1, "invented/unknown");
  assert.equal(unknown.error.code, -32601);
  for (const [id, params] of [
    [2, { name: "missing_tool", arguments: {} }],
    [
      3,
      {
        name: "cod_context",
        arguments: { workspaceId: "unrelated-workspace" },
      },
    ],
    [4, { name: "cod_help", arguments: [] }],
    [5, { name: "cod_context", arguments: null }],
  ])
    structuredFailure(await server.request(id, "tools/call", params));
  config.state.conversations[0].workspaceId = "unrelated-workspace";
  await server.configure(config);
  const moved = toolJson(
    await server.request(6, "tools/call", {
      name: "cod_context",
      arguments: {},
    }),
  );
  assert.equal(moved.workspace.id, "unrelated-workspace");
  assert.equal(moved.conversation.id, "bound-conversation");
  config.state = source().state;
  config.state.workspaces = config.state.workspaces.filter(
    (workspace) => workspace.id !== "bound-workspace",
  );
  await server.configure(config);
  structuredFailure(
    await server.request(7, "tools/call", {
      name: "cod_context",
      arguments: {},
    }),
  );
  config.state = source().state;
  config.state.conversations = [];
  await server.configure(config);
  structuredFailure(
    await server.request("missing-conversation", "tools/call", {
      name: "cod_context",
      arguments: {},
    }),
  );
  config.state = source().state;
  for (const [op, name] of [
    ["state", "cod_context"],
    ["capabilities", "cod_help"],
  ]) {
    config.failOp = op;
    config.failMessage =
      "PRIVATE_OTHER_TRANSCRIPT invented unrelated operation detail";
    await server.configure(config);
    const failure = await server.request(`private-error-${op}`, "tools/call", {
      name,
      arguments: {},
    });
    structuredFailure(failure);
    assert.doesNotMatch(
      JSON.stringify(failure),
      /PRIVATE_OTHER_TRANSCRIPT|unrelated operation detail/,
    );
  }
  delete config.failOp;
  await server.configure(config);
  assert.equal(
    toolJson(
      await server.request(9, "tools/call", {
        name: "cod_context",
        arguments: {},
      }),
    ).workspace.id,
    "bound-workspace",
  );
  assert.deepEqual((await server.request(10, "ping")).result, {});
});

test("AC5 concurrent IDs and split UTF-8 correlate exactly and EOF exits", async (t) => {
  const config = source();
  config.delayMs = 30;
  const server = await open(t, config);
  await server.initialize();
  const ids = Array.from({ length: 12 }, (_, index) =>
    index % 2 ? `request-${index}` : index,
  );
  await Promise.all(
    ids.map(async (id) => {
      const result = await server.request(id, "tools/call", {
        name: "cod_context",
        arguments: {},
      });
      assert.equal(result.id, id);
      assert.equal(toolJson(result).workspace.name, "Bound 🌱 fixture");
    }),
  );
  const id = "split-🌱-id",
    payload = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }) + "\n",
    );
  const split = payload.indexOf(Buffer.from("🌱")) + 1;
  server.child.stdin.write(payload.subarray(0, split));
  await pause(20);
  server.child.stdin.write(payload.subarray(split));
  assert.deepEqual((await server.response(id)).result, {});
  for (const value of [...ids, id])
    assert.equal(
      server.lines.filter((message) => message.id === value).length,
      1,
    );
  server.child.stdin.end();
  const exited = await Promise.race([
    server.exited,
    pause(1500).then(() => {
      throw new Error("EOF left server process running");
    }),
  ]);
  assert.equal(exited.code, 0);
});

test("AC5 oversized frames stay bounded and explicit double close terminates cleanly", async (t) => {
  const server = await open(t);
  await server.initialize();
  server.child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "oversized",
      method: "ping",
      params: { padding: "x".repeat(2 * 1024 * 1024) },
    }) + "\n",
  );
  await pause(200);
  assert(
    server.lines.some((message) => message.error) ||
      server.child.exitCode !== null ||
      server.child.signalCode !== null,
    "Oversized frame was not rejected",
  );
  if (server.child.exitCode === null && server.child.signalCode === null)
    assert.deepEqual((await server.request("after-limit", "ping")).result, {});
  const closed = await open(t, source(), "double-close");
  const exited = await Promise.race([
    closed.exited,
    pause(1500).then(() => {
      throw new Error("Explicit close left process running");
    }),
  ]);
  assert.equal(exited.code, 0);
  assert.deepEqual(closed.lines, []);
});

test("AC5 asynchronous output failure and peer-closed stdout shut down without uncaught errors", async (t) => {
  for (const mode of [
    "output-error",
    "output-error-eof",
    "output-error-close",
    "peer-closed-output",
  ]) {
    const server = await open(t, source(), mode);
    if (mode === "peer-closed-output") {
      await server.initialize();
      server.child.stdout.destroy();
      await pause(30);
    }
    server.send({ id: "trigger-output", method: "ping" });
    if (mode === "output-error-eof") server.child.stdin.end();
    const exited = await Promise.race([
      server.exited,
      pause(1500).then(() => {
        throw new Error(`${mode} left server running with input open`);
      }),
    ]);
    assert.equal(exited.code, 0, `${mode}: ${server.stderr()}`);
    assert.equal(exited.signal, null);
    assert.doesNotMatch(server.stderr(), /Unhandled|uncaught|Error:|PRIVATE_/i);
  }
});
