import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const [provider, mode, record] = process.argv.slice(2);
const id = "invented-session";
const out = (x) => process.stdout.write(JSON.stringify(x) + "\n");
const reply = (m, result) => out({ id: m.id, result });
let model = "native-a",
  reasoning = "low";
const config = () => [
  {
    id: "model",
    type: "select",
    currentValue: model,
    options: [
      { value: "native-a", name: "A" },
      { value: "native-b", name: "B" },
    ],
  },
  {
    id: "thinking",
    type: "select",
    currentValue: reasoning,
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  appendFileSync(record, line + "\n");
  if (m.method === "initialize")
    return reply(m, provider === "kimi" ? { protocolVersion: 1 } : {});
  if (
    ["thread/start", "thread/resume", "session/new", "session/load"].includes(
      m.method,
    )
  )
    return reply(
      m,
      provider === "codex"
        ? { thread: { id }, model, reasoningEffort: reasoning }
        : {
            sessionId: id,
            configOptions: mode === "malformed" ? {} : config(),
          },
    );
  if (m.method === "model/list") {
    const finish = () =>
      reply(
        m,
        mode === "malformed"
          ? { data: [{}] }
          : {
              data: [
                {
                  model: m.params.cursor ? "native-b" : "native-a",
                  displayName: "Fixture",
                  supportedReasoningEfforts: [
                    {
                      reasoningEffort: m.params.cursor ? "high" : "low",
                      description: "Fixture",
                    },
                  ],
                },
              ],
              nextCursor:
                mode === "repeat" ? "again" : m.params.cursor ? null : "next",
            },
      );
    if (mode === "delay") setTimeout(finish, 80);
    else finish();
    return;
  }
  if (m.method === "session/set_config_option") {
    if (mode === "reject")
      return out({
        id: m.id,
        error: { code: -32602, message: "Invented rejection" },
      });
    if (m.params.sessionId !== id)
      return out({
        id: m.id,
        error: { code: -32602, message: "Wrong session" },
      });
    if (m.params.configId === "model") model = m.params.value;
    else reasoning = m.params.value;
    out({
      method: "session/update",
      params: {
        sessionId: "foreign",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "model",
              type: "select",
              currentValue: "evil",
              options: [{ value: "evil", name: "Wrong" }],
            },
          ],
        },
      },
    });
    return reply(m, { configOptions: config() });
  }
  if (m.method === "turn/start") {
    if (mode === "reject")
      return out({
        id: m.id,
        error: { code: -32602, message: "Rejected start" },
      });
    reply(m, { turn: { id: "t" } });
    out({
      method: "turn/completed",
      params: { threadId: id, turn: { id: "t", status: "completed" } },
    });
  }
  if (m.method === "session/prompt") reply(m, { stopReason: "end_turn" });
});
