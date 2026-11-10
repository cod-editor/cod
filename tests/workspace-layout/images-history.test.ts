import assert from "node:assert/strict";
import { test } from "node:test";
import { commitHistory } from "../../src/conversation-history.ts";
import type { ConversationState } from "../../src/types.ts";
const fixture = (): ConversationState => ({
  id: "c",
  workspaceId: "w",
  paneId: "p",
  provider: "codex",
  nativeId: "n",
  cwd: "/fixture",
  status: "ready",
  messages: [
    {
      id: "local",
      role: "user",
      text: "Check this screenshot",
      order: 1,
      images: [{ mimeType: "image/png", data: "aW52ZW50ZWQ=" }],
    },
  ],
  tools: [],
  pendingPermissions: [],
});
test("native replay retains uniquely matching locally attached images", () => {
  const conversation = fixture();
  commitHistory(conversation, {
    messages: [
      {
        id: "native",
        role: "user",
        text: "Check this screenshot\n[Native image content]",
        order: 1,
      },
    ],
    tools: [],
    partial: false,
    order: 2,
  });
  assert.equal(conversation.messages[0]!.images?.[0]!.data, "aW52ZW50ZWQ=");
});
test("native replay never assigns cached screenshot to ambiguous identical prompts", () => {
  const conversation = fixture();
  commitHistory(conversation, {
    messages: [
      { id: "first", role: "user", text: "Check this screenshot", order: 1 },
      { id: "second", role: "user", text: "Check this screenshot", order: 2 },
    ],
    tools: [],
    partial: false,
    order: 3,
  });
  assert.ok(conversation.messages.every((message) => !message.images));
});

test("Codex replay preserves known timing identity and native phases without inventing imported timing", async () => {
  const { stageCodexSnapshot, emptyHistory } =
    await import("../../src/conversation-history.ts");
  const conversation = fixture();
  conversation.turns = [
    {
      id: "local-turn",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:02Z",
      durationMs: 700,
      elapsedMs: 2000,
      outcome: "completed",
    },
  ];
  conversation.messages.push({
    id: "codex/live/n/final-item",
    role: "assistant",
    text: "Done",
    order: 2,
    turnId: "local-turn",
    phase: "final",
  });
  const staged = emptyHistory();
  stageCodexSnapshot(
    staged,
    {
      turns: [
        {
          id: "native-turn",
          items: [
            {
              id: "user",
              type: "userMessage",
              content: [{ type: "text", text: "Check this screenshot" }],
            },
            {
              id: "comment",
              type: "agentMessage",
              phase: "commentary",
              text: "Checking",
            },
            {
              id: "final-item",
              type: "agentMessage",
              phase: "final_answer",
              text: "Done",
            },
          ],
        },
        {
          id: "imported-turn",
          items: [{ id: "imported", type: "agentMessage", text: "Old answer" }],
        },
      ],
    },
    {},
    "n",
  );
  commitHistory(conversation, staged);
  assert.equal(conversation.messages[1]!.phase, "commentary");
  assert.equal(conversation.messages[2]!.phase, "final");
  assert.equal(conversation.messages[0]!.turnId, "local-turn");
  assert.equal(conversation.turns[0]!.durationMs, 700);
  assert.equal(
    conversation.turns.find(
      (turn) => turn.id === conversation.messages[3]!.turnId,
    ),
    undefined,
  );
});
