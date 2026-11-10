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
