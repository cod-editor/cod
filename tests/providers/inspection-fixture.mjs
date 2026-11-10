import { createInterface } from "node:readline";
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ id, result }) + "\n");
const notify = (method, params) =>
  process.stdout.write(JSON.stringify({ method, params }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") reply(m.id, {});
  else if (m.method === "thread/start")
    reply(m.id, { thread: { id: "fixture-native" } });
  else if (m.method === "skills/list")
    reply(m.id, {
      data: [
        {
          skills: [
            { name: "example", path: "/fixture/SKILL.md", enabled: true },
            { name: "duplicate", path: "/first/SKILL.md", enabled: true },
            { name: "duplicate", path: "/second/SKILL.md", enabled: true },
          ],
          errors: [],
        },
      ],
    });
  else if (m.method === "account/rateLimits/read")
    reply(m.id, {
      rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 } },
    });
  else if (m.method === "turn/start") {
    const skill = m.params.input.find((i) => i.type === "skill");
    if (
      m.params.input.filter((item) => item.type === "skill").length !== 1 ||
      !(
        (skill?.name === "example" && skill.path === "/fixture/SKILL.md") ||
        (skill?.name === "duplicate" && skill.path === "/second/SKILL.md")
      )
    ) {
      process.stdout.write(
        JSON.stringify({
          id: m.id,
          error: { code: -32602, message: "Missing native skill" },
        }) + "\n",
      );
      return;
    }
    reply(m.id, { turn: { id: "fixture-turn" } });
    notify("thread/tokenUsage/updated", {
      threadId: "foreign",
      tokenUsage: { last: { inputTokens: 999 } },
    });
    notify("thread/tokenUsage/updated", {
      threadId: "fixture-native",
      turnId: "fixture-turn",
      tokenUsage: {
        last: { inputTokens: 42, totalTokens: 50 },
        total: { totalTokens: 50 },
        modelContextWindow: 1000,
      },
    });
    notify("turn/completed", {
      threadId: "fixture-native",
      turn: { id: "fixture-turn", status: "completed" },
    });
  } else
    process.stdout.write(
      JSON.stringify({
        id: m.id,
        error: { code: -32601, message: "Unsupported fixture request" },
      }) + "\n",
    );
});
