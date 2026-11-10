// Invented native-protocol subprocess; opt-in actions use the actual packaged Cod CLI.
import { inspectionResponse, moveConversation } from "./actions.mjs";
import { createInterface } from "node:readline";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const [provider, recording] = process.argv.slice(2);
if (!["codex", "kimi"].includes(provider) || !recording)
  throw new Error("Expected provider and isolated recording path");
let nativeId;
let active;
let sequence = 0;
let history = [];
const historyDirectory = recording + ".sessions";
mkdirSync(historyDirectory, { recursive: true });
const persist = () => {
  const destination = path.join(historyDirectory, nativeId + ".json");
  const temporary = destination + ".tmp-" + process.pid;
  writeFileSync(temporary, JSON.stringify(history));
  renameSync(temporary, destination);
};
const configuration = () => {
  const file = recording + ".config.json";
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8"))[provider] ?? {})
    : {};
};
const timers = new Set();
const record = (event, data = {}) =>
  appendFileSync(
    recording,
    JSON.stringify({ event, provider, pid: process.pid, ...data }) + "\n",
  );
const write = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const reply = (message, result) => write({ id: message.id, result });
const notify = (method, params) => write({ method, params });
const later = (callback, delay) => {
  const timer = setTimeout(() => {
    timers.delete(timer);
    callback();
  }, delay);
  timers.add(timer);
};
const clearTimers = () => {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
};
function text(value, foreign = false) {
  const itemId = `assistant-${active.turnId}-${active.turn.items.length}`;
  if (!foreign) {
    active.turn.items.push({ id: itemId, type: "agentMessage", text: value });
    persist();
  }
  if (provider === "codex")
    notify("item/agentMessage/delta", {
      threadId: foreign ? "foreign-session" : nativeId,
      turnId: active.turnId,
      itemId,
      delta: value,
    });
  else
    notify("session/update", {
      sessionId: foreign ? "foreign-session" : nativeId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: value },
      },
    });
}
function replayKimi() {
  for (const turn of history)
    for (const item of turn.items) {
      if (item.type === "userMessage" || item.type === "agentMessage")
        notify("session/update", {
          sessionId: nativeId,
          update: {
            sessionUpdate:
              item.type === "userMessage"
                ? "user_message_chunk"
                : "agent_message_chunk",
            content: {
              type: "text",
              text:
                item.type === "userMessage"
                  ? item.content.map((part) => part.text).join("")
                  : item.text,
            },
          },
        });
      else if (item.type === "commandExecution") {
        notify("session/update", {
          sessionId: nativeId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: item.id,
            title: "invented-tool",
            status: item.status,
          },
        });
        notify("session/update", {
          sessionId: nativeId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: item.id,
            status: item.status,
            content: [
              {
                type: "content",
                content: { type: "text", text: item.aggregatedOutput ?? "" },
              },
            ],
          },
        });
      }
    }
}
function complete(cancelled = false) {
  if (!active) return;
  clearTimers();
  active.turn.status = cancelled ? "interrupted" : "completed";
  const tool = active.turn.items.find(
    (item) => item.type === "commandExecution",
  );
  if (tool) {
    tool.status = cancelled ? "failed" : "completed";
    tool.aggregatedOutput = "invented-output";
  }
  persist();
  record("completed", { nativeId, cancelled });
  if (provider === "codex")
    notify("turn/completed", {
      threadId: nativeId,
      turn: {
        id: active.turnId,
        status: cancelled ? "interrupted" : "completed",
      },
    });
  else
    reply(active.request, { stopReason: cancelled ? "cancelled" : "end_turn" });
  active = undefined;
}
record("started");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  record("received", { nativeId, message });
  if (!message.method) {
    if (active && message.id === active.permissionId) {
      const allowed =
        provider === "codex"
          ? message.result?.decision === "accept"
          : message.result?.outcome?.optionId === "allow-once";
      text(`${allowed ? "ALLOWED" : "DENIED"} ${active.prompt}`);
      complete();
    }
    return;
  }
  const params = message.params ?? {};
  if (message.method === "initialize") {
    const config = configuration();
    const initialize = () =>
      config.initializeError
        ? process.exit(17)
        : reply(message, provider === "kimi" ? { protocolVersion: 1 } : {});
    if (config.initializeDelayMs) later(initialize, config.initializeDelayMs);
    else initialize();
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list" && configuration().options) {
    reply(message, {
      data: [
        {
          model: "fixture-model",
          displayName: "Fixture model",
          supportedReasoningEfforts: configuration().reasoningOptions
            ? [
                {
                  reasoningEffort: "low",
                  description: "Fast responses with lighter reasoning",
                },
                {
                  reasoningEffort: "medium",
                  description:
                    "Balances speed and reasoning quality for typical development tasks",
                },
                {
                  reasoningEffort: "high",
                  description: "More detailed reasoning for difficult problems",
                },
              ]
            : [],
        },
        ...(configuration().multipleModels
          ? [
              {
                model: "fixture-alternate",
                displayName: "Alternate fixture",
                supportedReasoningEfforts: [],
              },
            ]
          : []),
      ],
      nextCursor: null,
    });
    return;
  }
  if (
    ["thread/start", "session/new", "thread/resume", "session/load"].includes(
      message.method,
    )
  ) {
    nativeId =
      params.threadId ??
      params.sessionId ??
      `${provider}-fixture-${randomUUID()}`;
    if (path.basename(nativeId) !== nativeId)
      throw new Error("Invalid fixture identity");
    const saved = path.join(historyDirectory, nativeId + ".json");
    history = existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : [];
    sequence = history.length;
    if (provider === "kimi" && message.method === "session/load") replayKimi();
    if (
      provider === "codex" &&
      message.method === "thread/resume" &&
      configuration().partialTail
    ) {
      const last = history.at(-1);
      const assistant = last?.items
        .filter((item) => item.type === "agentMessage")
        .at(-1);
      reply(message, {
        thread: {
          id: nativeId,
          historyMode: "paginated",
          turns: last && assistant ? [{ ...last, items: [assistant] }] : [],
        },
        turnsBackwardsCursor: "fixture-older-page",
      });
    } else
      reply(
        message,
        provider === "codex"
          ? {
              thread: { id: nativeId, turns: history },
              ...(configuration().reasoningOptions
                ? { model: "fixture-model", reasoningEffort: "medium" }
                : {}),
            }
          : {
              sessionId: nativeId,
              ...(configuration().options
                ? {
                    configOptions: [
                      {
                        id: "model",
                        type: "select",
                        currentValue: "fixture-model",
                        options: [
                          { value: "fixture-model", name: "Fixture model" },
                        ],
                      },
                    ],
                  }
                : {}),
            },
      );
    return;
  }
  if (["turn/interrupt", "session/cancel"].includes(message.method)) {
    if (message.id !== undefined) reply(message, {});
    complete(true);
    return;
  }
  const inspected = inspectionResponse(
    message.method,
    configuration(),
    nativeId,
  );
  if (inspected !== undefined) {
    reply(message, inspected);
    return;
  }
  if (!["turn/start", "session/prompt"].includes(message.method)) {
    if (message.id !== undefined)
      write({
        id: message.id,
        error: { code: -32601, message: "Unsupported fixture method" },
      });
    return;
  }
  const prompt = (params.input ?? params.prompt ?? [])
    .map((part) => part.text ?? "")
    .join("");
  active = {
    request: message,
    prompt,
    turnId: `turn-${++sequence}`,
    permissionId: `approval-${sequence}`,
  };
  active.turn = {
    id: active.turnId,
    status: "inProgress",
    items: [
      {
        id: `user-${active.turnId}`,
        type: "userMessage",
        content: [{ type: "text", text: prompt }],
      },
    ],
  };
  history.push(active.turn);
  persist();
  if (provider === "codex") reply(message, { turn: { id: active.turnId } });
  if (prompt.includes("[move-workspace]")) {
    later(() => {
      text("Preparing the review before moving this conversation.\n");
      void moveConversation(configuration, (event, data) =>
        record(event, { nativeId, ...data }),
      )
        .then((target) => {
          text(`Moved this same conversation to ${target}. Turn continued.`);
          complete();
        })
        .catch((error) => {
          text(`FIXTURE_ACTION_FAILED: ${error.message}`);
          complete();
        });
    }, 100);
    return;
  }
  if (prompt.includes("[crash]")) {
    later(() => process.exit(23), 200);
    return;
  }
  later(() => {
    text("FOREIGN_OUTPUT", true);
    if (configuration().narrative) text(configuration().narrative);
    text(`STREAM ${prompt}\n`);
    const tool = {
      id: `fixture-tool-${active.turnId}`,
      type: "commandExecution",
      command: "echo invented-tool",
      status: "inProgress",
    };
    active.turn.items.push(tool);
    persist();
    if (provider === "codex")
      notify("item/started", {
        threadId: nativeId,
        turnId: active.turnId,
        item: tool,
      });
    else
      notify("session/update", {
        sessionId: nativeId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: tool.id,
          title: "invented-tool",
          status: "pending",
        },
      });
    if (provider === "codex") {
      for (let index = 0; index < (configuration().extraTools ?? 0); index++) {
        const extra = {
          id: `fixture-extra-${active.turnId}-${index}`,
          type: "commandExecution",
          command:
            configuration().toolCommands?.[index] ??
            `echo invented-extra-${index}`,
          status: configuration().failExtraTool ? "failed" : "completed",
          aggregatedOutput: configuration().failExtraTool
            ? "Invented tool failed: fixture permission denied"
            : `Fixture detail ${index}`,
        };
        active.turn.items.push(extra);
        notify("item/started", {
          threadId: nativeId,
          turnId: active.turnId,
          item: extra,
        });
        notify("item/completed", {
          threadId: nativeId,
          turnId: active.turnId,
          item: extra,
        });
      }
      persist();
    }
    if (prompt.includes("[approve]")) {
      write({
        id: active.permissionId,
        method:
          provider === "codex"
            ? "item/commandExecution/requestApproval"
            : "session/request_permission",
        params:
          provider === "codex"
            ? {
                threadId: nativeId,
                turnId: active.turnId,
                itemId: tool.id,
                command: "echo invented-tool",
              }
            : {
                sessionId: nativeId,
                toolCall: {
                  toolCallId: tool.id,
                  title: "invented-tool",
                },
                options: [
                  {
                    optionId: "allow-once",
                    name: "Allow once",
                    kind: "allow_once",
                  },
                  { optionId: "deny", name: "Deny", kind: "reject_once" },
                ],
              },
      });
    } else if (!prompt.includes("[hold]"))
      later(() => {
        text(`DONE ${prompt}`);
        complete();
      }, 500);
  }, configuration().streamDelayMs ?? 200);
});
