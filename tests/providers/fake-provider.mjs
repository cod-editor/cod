import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const provider = process.argv[2];
const mode = process.argv[3] || "normal";
const sessionId = `${provider}-native`;
let toolPid;
if (mode === "owned-child") {
  const tool = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready\\n');",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  toolPid = tool.pid;
  await new Promise((resolve) => tool.stdout.once("data", resolve));
}

let activeRequest;
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (request, result) => write({ id: request.id, result });
const notify = (method, params) => write({ method, params });
function complete(status = "completed") {
  if (provider === "codex")
    notify("turn/completed", {
      threadId: sessionId,
      turn: { id: "turn-1", status },
    });
  else
    reply(activeRequest, {
      stopReason: status === "interrupted" ? "cancelled" : "end_turn",
    });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (process.argv[4])
    appendFileSync(process.argv[4], JSON.stringify(m) + "\n");
  if (!m.method) {
    if (m.id === "foreign") return;
    if (m.id === "approval") {
      const denied =
        provider === "codex"
          ? m.result?.decision === "decline"
          : m.result?.outcome?.optionId === "deny-option";
      notify(
        provider === "codex" ? "item/agentMessage/delta" : "session/update",
        provider === "codex"
          ? {
              threadId: sessionId,
              turnId: "turn-1",
              delta: denied ? "DENIED" : "ALLOWED",
            }
          : {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: denied ? "DENIED" : "ALLOWED" },
              },
            },
      );
      complete();
    }
    return;
  }
  if (m.method === "initialize") {
    if (mode === "malformed") {
      process.stdout.write("not json\n");
      return;
    }
    if (mode === "exit") {
      process.exit(7);
    }
    if (mode === "timeout") return;
    if (mode === "stderr") process.stderr.write("invented diagnostic\n");
    if (mode === "oversized") {
      process.stdout.write("x".repeat(4 * 1024 * 1024 + 1));
      return;
    }
    if (mode === "split") {
      const bytes = Buffer.from(
        JSON.stringify({
          id: m.id,
          result:
            provider === "kimi"
              ? { protocolVersion: 1, note: "🌱" }
              : { note: "🌱" },
        }) + "\n",
      );
      const split = bytes.indexOf(Buffer.from("🌱")) + 1;
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
      return;
    }
    if (mode === "unmatched")
      write({ id: m.id + 999, result: { substituted: true } });
    reply(m, provider === "kimi" ? { protocolVersion: 1 } : {});
    return;
  }
  if (m.method === "initialized") return;
  if (
    ["thread/start", "thread/resume", "session/new", "session/load"].includes(
      m.method,
    )
  ) {
    if (mode === "wrong-id") {
      reply(m, { thread: { id: "wrong" } });
      return;
    }
    if (m.method === "session/load")
      notify("session/update", {
        sessionId: m.params.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "old question" },
        },
      });
    reply(
      m,
      provider === "codex"
        ? { thread: { id: sessionId, turns: [{ id: "old-turn" }], toolPid } }
        : { sessionId, toolPid },
    );
    return;
  }
  if (["thread/list", "session/list"].includes(m.method)) {
    reply(
      m,
      provider === "codex"
        ? { data: [{ id: sessionId, cwd: m.params.cwd }], nextCursor: null }
        : { sessions: [{ sessionId, cwd: m.params.cwd }] },
    );
    return;
  }
  if (m.method === "turn/interrupt" || m.method === "session/cancel") {
    if (m.id !== undefined) reply(m, {});
    complete("interrupted");
    return;
  }
  if (!["turn/start", "session/prompt"].includes(m.method)) return;
  activeRequest = m;
  if (mode === "images") {
    const content = provider === "codex" ? m.params.input : m.params.prompt;
    const image = content.find((item) => item.type === "image");
    const valid =
      provider === "codex"
        ? image?.url === "data:image/png;base64,aW52ZW50ZWQ="
        : image?.mimeType === "image/png" && image?.data === "aW52ZW50ZWQ=";
    if (!valid) {
      write({
        id: m.id,
        error: { code: -32000, message: "Missing native image payload" },
      });
      return;
    }
  }
  if (mode === "rpc-error") {
    write({
      id: m.id,
      error: { code: -32000, message: "Invented provider failure" },
    });
    return;
  }
  if (mode === "crash-turn") {
    setTimeout(() => process.exit(9), 10);
    return;
  }
  if (provider === "codex") {
    // Deliberately send early notifications before the turn/start response.
    notify("item/agentMessage/delta", {
      threadId: "another-session",
      turnId: "turn-1",
      delta: "FOREIGN",
    });
    notify("item/agentMessage/delta", {
      threadId: sessionId,
      turnId: "old-turn",
      delta: "STALE",
    });
    notify("item/agentMessage/delta", {
      threadId: sessionId,
      turnId: "turn-1",
      delta: "hello",
    });
    if (mode === "early-cancel")
      setTimeout(() => reply(m, { turn: { id: "turn-1" } }), 25);
    else reply(m, { turn: { id: "turn-1" } });
    notify("item/started", {
      threadId: sessionId,
      turnId: "turn-1",
      item: { type: "commandExecution", id: "tool-1", command: "invented" },
    });
  } else {
    notify("session/update", {
      sessionId: "another-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "FOREIGN" },
      },
    });
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    });
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "invented",
        status: "pending",
      },
    });
  }
  if (mode === "cancel" || mode === "dispose" || mode === "early-cancel")
    return;
  if (mode === "approval") {
    const params =
      provider === "codex"
        ? { threadId: sessionId, turnId: "turn-1", itemId: "tool-1" }
        : {
            sessionId,
            toolCall: { toolCallId: "tool-1" },
            options: [
              { optionId: "deny-option", kind: "reject_once", name: "Deny" },
              {
                optionId: "allow-option",
                kind: "allow_once",
                name: "Allow once",
              },
            ],
          };
    const method =
      provider === "codex"
        ? "item/commandExecution/requestApproval"
        : "session/request_permission";
    write({
      id: "foreign",
      method,
      params: {
        ...params,
        threadId: "another-session",
        sessionId: "another-session",
      },
    });
    write({ id: "approval", method, params });
    return;
  }
  complete();
});
