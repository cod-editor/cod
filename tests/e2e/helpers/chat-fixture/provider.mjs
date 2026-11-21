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
  watch,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const [provider, recording] = process.argv.slice(2);
if (!["codex", "kimi"].includes(provider) || !recording)
  throw new Error("Expected provider and isolated recording path");
let nativeId;
let queueWatcher;
let lastQueueId;
let active;
let sequence = 0;
let history = [];
let selectedModel = "fixture-model";
const kimiConfigOptions = () => [
  {
    id: "model",
    type: "select",
    currentValue: selectedModel,
    options: [
      { value: "fixture-model", name: "Fixture model" },
      ...(configuration().multipleModels
        ? [{ value: "fixture-alternate", name: "Alternate fixture" }]
        : []),
    ],
  },
];
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
function text(
  value,
  foreign = false,
  phase = "final_answer",
  interactive = false,
) {
  const questions = interactive ? { questions: [{ question: value }] } : {};
  const itemId = `assistant-${active.turnId}-${active.turn.items.length}`;
  if (!foreign) {
    active.turn.items.push({
      id: itemId,
      type: "agentMessage",
      text: value,
      ...(provider === "codex" ? { phase, ...questions } : {}),
    });
    persist();
  }
  if (provider === "codex") {
    notify("item/started", {
      threadId: foreign ? "foreign-session" : nativeId,
      turnId: active.turnId,
      item: { id: itemId, type: "agentMessage", phase, ...questions },
    });
    notify("item/agentMessage/delta", {
      threadId: foreign ? "foreign-session" : nativeId,
      turnId: active.turnId,
      itemId,
      delta: value,
    });
    notify("item/completed", {
      threadId: foreign ? "foreign-session" : nativeId,
      turnId: active.turnId,
      item: {
        id: itemId,
        type: "agentMessage",
        text: value,
        phase,
        ...questions,
      },
    });
  } else
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
    if (provider === "codex")
      notify("item/completed", {
        threadId: nativeId,
        turnId: active.turnId,
        item: tool,
      });
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
  if (
    provider === "codex" &&
    configuration().queueAfterCompletion &&
    !lastQueueId
  ) {
    lastQueueId = "automatic-follow-up";
    receive(
      {
        method: "turn/start",
        params: {
          input: [{ type: "text", text: "Queued immediately [hold]" }],
        },
      },
      true,
    );
  }
}
record("started");
createInterface({ input: process.stdin }).on("line", (line) =>
  receive(JSON.parse(line)),
);
function receive(message, external = false) {
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

  if (message.method === "session/set_config_option" && provider === "kimi") {
    later(() => {
      if (configuration().optionError)
        write({
          id: message.id,
          error: { code: -32000, message: "Invented selection rejection" },
        });
      else {
        selectedModel = params.value;
        reply(message, { configOptions: kimiConfigOptions() });
      }
    }, configuration().optionDelayMs ?? 0);
    return;
  }
  if (message.method === "model/list" && configuration().options) {
    reply(message, {
      data: [
        {
          model: "fixture-model",
          displayName: configuration().modelDisplayName ?? "Fixture model",
          isDefault: true,
          defaultReasoningEffort: "medium",
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
                ...(configuration().alternateReasoning
                  ? {
                      defaultReasoningEffort: "high",
                      supportedReasoningEfforts: [
                        { reasoningEffort: "high", description: "Thorough" },
                        {
                          reasoningEffort: "xhigh",
                          description: "Most thorough",
                        },
                      ],
                    }
                  : { supportedReasoningEfforts: [] }),
              },
            ]
          : []),
      ],
      nextCursor: null,
    });
    return;
  }
  if (
    message.method === "thread/turns/list" &&
    params.itemsView === "summary"
  ) {
    reply(message, {
      data: history.map(({ id, status }) => ({ id, status })),
      nextCursor: null,
    });
    return;
  }
  if (message.method === "thread/items/list" && params.turnId) {
    const turn = history.find((item) => item.id === params.turnId);
    if (!turn || params.threadId !== nativeId) {
      write({
        id: message.id,
        error: { code: -32602, message: "Unknown fixture turn" },
      });
      return;
    }
    reply(message, {
      data: turn.items.map((item) => ({ turnId: turn.id, item })),
      nextCursor: null,
    });
    return;
  }
  if (message.method === "thread/items/list" && configuration().pagedHistory) {
    const items = history
      .flatMap(({ id: turnId, items }) =>
        items.map((item) => ({ turnId, item })),
      )
      .reverse();
    const offset = Number(params.cursor?.match(/^fixture-items-(\d+)$/)?.[1]);
    if (
      configuration().earlierHistoryError ||
      params.threadId !== nativeId ||
      params.sortDirection !== "desc" ||
      params.limit !== 50 ||
      !Number.isSafeInteger(offset)
    ) {
      write({
        id: message.id,
        error: { code: -32000, message: "Invented history page failure" },
      });
      return;
    }
    const data = items.slice(offset, offset + 3);
    const next = offset + data.length;
    later(
      () =>
        reply(message, {
          data,
          nextCursor: next < items.length ? "fixture-items-" + next : null,
          backwardsCursor: null,
        }),
      configuration().earlierHistoryDelayMs ?? 0,
    );
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
      (configuration().partialTail || configuration().pagedHistory)
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
        ...(configuration().pagedHistory && last
          ? { itemsBackwardsCursor: "fixture-items-0" }
          : {}),
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
                    configOptions: kimiConfigOptions(),
                  }
                : {}),
            },
      );
    if (provider === "codex" && !queueWatcher) {
      queueWatcher = watch(historyDirectory, (_event, filename) => {
        if (filename !== nativeId + ".queue.json") return;
        const queued = JSON.parse(
          readFileSync(path.join(historyDirectory, filename), "utf8"),
        );
        if (queued.id === lastQueueId || active) return;
        if (
          configuration().backgroundActivity &&
          Array.isArray(queued.events)
        ) {
          lastQueueId = queued.id;
          for (const { method, params } of queued.events)
            notify(method, params);
          return;
        }
        lastQueueId = queued.id;
        receive(
          {
            method: "turn/start",
            params: { input: [{ type: "text", text: queued.text }] },
          },
          true,
        );
      });
    }
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
  if (["thread/list", "session/list"].includes(message.method)) {
    const config = configuration();
    const respond = () => {
      if (config.discoveryError) {
        write({
          id: message.id,
          error: { code: -32000, message: "Invented discovery failure" },
        });
        return;
      }
      const rows = (config.sessions ?? []).map((session) => ({
        ...(provider === "codex"
          ? { id: session.nativeId }
          : { sessionId: session.nativeId }),
        cwd: session.cwd,
        name: session.name,
        preview: session.preview,
      }));
      reply(
        message,
        provider === "codex"
          ? { data: rows, nextCursor: null }
          : { sessions: rows, nextCursor: null },
      );
    };
    if (config.discoveryDelayMs) later(respond, config.discoveryDelayMs);
    else respond();
    return;
  }

  if (message.method === "turn/steer" && provider === "codex") {
    const mode = configuration().steering;
    if (mode === "unsupported") {
      write({
        id: message.id,
        error: { code: -32601, message: "Unsupported fixture method" },
      });
      return;
    }
    if (
      params.threadId !== nativeId ||
      !active ||
      params.expectedTurnId !== active.turnId ||
      mode === "reject"
    ) {
      write({
        id: message.id,
        error: { code: -32600, message: "Fixture turn no longer active" },
      });
      return;
    }
    const turn = active.turn;
    const item = {
      id: `steered-${turn.id}-${turn.items.length}`,
      type: "userMessage",
      clientId: params.clientUserMessageId,
      content: params.input,
    };
    if (mode !== "absent") {
      turn.items.push(item);
      persist();
    }
    reply(message, { turnId: turn.id });
    if (mode !== "silent" && mode !== "absent")
      for (const method of ["item/started", "item/completed"])
        notify(method, { threadId: nativeId, turnId: turn.id, item });
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
  const toolResult = params.toolOutput;
  const recordToolResult = () => {
    const item = {
      id: `result-${active.turnId}-${active.turn.items.length}`,
      type: "functionCallOutput",
      name: toolResult.name,
      namespace: toolResult.namespace,
      output: toolResult.output,
    };
    if (toolResult.retain) {
      active.turn.items.push(item);
      persist();
    }
    for (const method of ["item/started", "item/completed"])
      notify(method, { threadId: nativeId, turnId: active.turnId, item });
  };
  if (provider === "codex" && toolResult && active) {
    reply(message, { turn: { id: active.turnId, status: "inProgress" } });
    recordToolResult();
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
    items: toolResult
      ? []
      : [
          {
            id: `user-${active.turnId}`,
            type: "userMessage",
            content: [{ type: "text", text: prompt }],
          },
        ],
  };
  history.push(active.turn);
  persist();
  if (provider === "kimi" && configuration().emptyReply) {
    complete();
    return;
  }
  if (provider === "codex") {
    if (!external) reply(message, { turn: { id: active.turnId } });
    notify("turn/started", {
      threadId: nativeId,
      turn: { id: active.turnId, status: "inProgress" },
    });
    if (toolResult) {
      recordToolResult();
      later(() => {
        text("Tool result received.");
        complete();
      }, 100);
      return;
    }
    notify("item/started", {
      threadId: nativeId,
      turnId: active.turnId,
      item: active.turn.items[0],
    });
    notify("item/completed", {
      threadId: nativeId,
      turnId: active.turnId,
      item: active.turn.items[0],
    });
  }
  if (provider === "codex" && prompt.startsWith("[latency-fixture]")) {
    const { latencyChunks = 105 } = configuration();
    const item = {
      id: "latency-" + active.turnId,
      type: "agentMessage",
      phase: prompt.includes("move-to-final") ? undefined : "final_answer",
      text: "",
    };
    active.turn.items.push(item);
    const turnId = active.turnId;
    notify("item/started", { threadId: nativeId, turnId, item });
    const finish = () => {
      if (configuration().holdLatencyCompletion) {
        later(finish, 30);
        return;
      }
      notify("item/completed", { threadId: nativeId, turnId, item });
      complete();
    };
    let step = 0;
    const tick = () => {
      const delta = `inventedstream-${++step}-${Date.now()}; `;
      item.text += delta;
      notify("item/agentMessage/delta", {
        threadId: nativeId,
        turnId,
        itemId: item.id,
        delta,
      });
      if (step < latencyChunks) later(tick, 50);
      else finish();
    };
    later(tick, 150);
    return;
  }
  if (provider === "codex" && configuration().backgroundActivity) {
    const turnId = active.turnId;
    const child = "invented-child";
    const command = {
      type: "commandExecution",
      id: "invented-shell",
      command: "echo test checks",
      status: "inProgress",
    };
    notify("item/completed", {
      threadId: nativeId,
      turnId,
      item:
        configuration().backgroundActivity === "legacy"
          ? {
              type: "collabAgentToolCall",
              tool: "spawnAgent",
              status: "completed",
              id: "spawn-child",
              senderThreadId: nativeId,
              receiverThreadIds: [child],
              agentsStates: { [child]: { status: "pendingInit" } },
            }
          : {
              type: "subAgentActivity",
              id: "spawn-child",
              kind: "started",
              agentThreadId: child,
              agentPath: "/root/checker",
            },
    });
    notify("item/started", {
      threadId: "unrelated-thread",
      turnId,
      item: { ...command, command: "unrelated work" },
    });
    notify("item/started", {
      threadId: child,
      turnId: "child-turn",
      item: command,
    });
    if (configuration().backgroundActivity === "legacy") {
      const rootCommand = {
        ...command,
        id: "invented-root-shell",
        command: "echo parent check",
      };
      notify("item/started", { threadId: nativeId, turnId, item: rootCommand });
    }
    text("Tests are running in the background.");
    complete();
    return;
  }
  if (configuration().finalOnly) {
    later(() => {
      text(`DONE ${prompt}`);
      complete();
    }, 100);
    return;
  }
  if (prompt.includes("[move-workspace]")) {
    later(() => {
      text(
        "Preparing the review before moving this conversation.\n",
        false,
        "commentary",
      );
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
    if (configuration().narrative)
      text(configuration().narrative, false, "commentary");
    text(`STREAM ${prompt}\n`, false, "commentary");
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
        if (configuration().interactiveQuestion)
          text(
            "Should the report include archived rows?",
            false,
            "commentary",
            true,
          );
        if (!configuration().noFinalReply) text(`DONE ${prompt}`);
        complete();
      }, configuration().finalDelayMs ?? 500);
  }, configuration().streamDelayMs ?? 200);
}
