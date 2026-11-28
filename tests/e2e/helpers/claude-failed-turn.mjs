#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const cwd = process.cwd();
const nativeId = process.argv
  .find((arg) => arg.startsWith("--session-id=") || arg.startsWith("--resume="))
  ?.split("=")[1];
if (!nativeId) throw new Error("Missing invented native session ID");
const profile = process.env.CLAUDE_CONFIG_DIR;
const directory = path.join(
  profile,
  "projects",
  cwd.replace(/[^a-zA-Z0-9-]/g, "-"),
);
mkdirSync(directory, { recursive: true });
const permissionIds = [
  "invented-first-permission",
  "invented-second-permission",
];
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\n");
function result(isError, uuid) {
  emit({
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    session_id: nativeId,
    user_message_uuid: uuid,
    uuid: randomUUID(),
    ...(isError ? { errors: ["Invented provider failure"] } : { result: "" }),
  });
}
function ask(id, agentId) {
  emit({
    type: "control_request",
    request_id: id,
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      tool_use_id: id,
      input: { command: "printf invented" },
      ...(agentId && { agent_id: agentId }),
    },
  });
}
function whenSignalled(name, send) {
  const timer = setInterval(() => {
    if (!existsSync(path.join(profile, name))) return;
    clearInterval(timer);
    send();
  }, 25);
  timer.unref();
}

for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") {
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: frame.request_id,
        response: { commands: [], agents: [], models: [], account: {} },
      },
    });
  }
  if (frame.type !== "user") continue;
  const incoming = Object.assign({}, frame, { session_id: nativeId });
  appendFileSync(
    path.join(profile, "received.jsonl"),
    JSON.stringify(incoming) + "\n",
  );
  appendFileSync(
    path.join(directory, nativeId + ".jsonl"),
    JSON.stringify({
      ...incoming,
      cwd,
      sessionId: nativeId,
      timestamp: new Date().toISOString(),
      parentUuid: null,
      isSidechain: false,
    }) + "\n",
  );
  emit({ ...incoming, isReplay: true });
  const text = incoming.message.content[0]?.text;
  if (text !== "Trigger the invented provider failure") {
    result(false, incoming.uuid);
    if (text === "An invented queued follow-up")
      whenSignalled("background-approval", () =>
        ask("invented-background-permission", "invented-native-subagent"),
      );
    continue;
  }
  for (const id of permissionIds) ask(id);
  whenSignalled("fail-turn", () => {
    result(true, incoming.uuid);
    whenSignalled("cancel-permissions", () => {
      for (const id of permissionIds)
        emit({ type: "control_cancel_request", request_id: id });
      emit({
        type: "system",
        subtype: "status",
        status: null,
        permissionMode: "acceptEdits",
        session_id: nativeId,
        uuid: randomUUID(),
      });
    });
  });
}
