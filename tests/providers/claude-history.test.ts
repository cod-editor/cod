import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitHistory,
  emptyHistory,
  stageClaudeHistory,
} from "../../src/conversation-history.ts";
import type { ConversationState } from "../../src/types";

test("Claude replay restores native prompt identity, image, reply and tool outcome", () => {
  const nativeId = "c18a585d-5f87-4fd8-b084-31242bcb669d";
  const row = (
    uuid: string,
    role: "user" | "assistant",
    content: unknown[],
  ) => ({
    session_id: nativeId,
    uuid,
    message: {
      role,
      content,
      ...(role === "assistant" ? { id: "reply" } : {}),
    },
  });
  const image = { type: "base64", media_type: "image/png", data: "aW1hZ2U=" };
  const staged = emptyHistory();
  stageClaudeHistory(
    staged,
    [
      row("local-prompt", "user", [
        { type: "text", text: "Inspect my file" },
        { type: "image", source: image },
      ]),
      row("assistant-text", "assistant", [{ type: "text", text: "One" }]),
      row("assistant-tool", "assistant", [
        { type: "tool_use", id: "call", name: "Write", input: {} },
      ]),
      row("tool-result", "user", [
        {
          type: "tool_result",
          tool_use_id: "call",
          is_error: true,
          content: "Denied",
        },
      ]),
      row("native-stop", "user", [
        { type: "text", text: "[Request interrupted by user for tool use]" },
      ]),
      {
        ...row("different-session", "user", [{ type: "text", text: "Wrong" }]),
        session_id: "other",
      },
    ],
    nativeId,
  );
  assert.deepEqual(
    staged.messages.map(({ role, text }) => ({ role, text })),
    [
      { role: "user", text: "Inspect my file" },
      { role: "assistant", text: "One" },
    ],
  );
  assert.equal(staged.messages[0]!.images?.[0]?.data, image.data);
  assert.equal(staged.tools[0]?.phase, "completed");
  assert.deepEqual(staged.tools[0]?.details, {
    toolCallId: "call",
    kind: "Write",
    title: "Write",
    input: {},
    output: "Denied",
    status: "failed",
  });

  const ids = staged.messages.map((message) => message.id);
  const conversation: ConversationState = {
    id: "chat",
    provider: "claude",
    nativeId,
    workspaceId: "workspace",
    paneId: "pane",
    cwd: "/project",
    status: "ready",
    pendingPermissions: [],
    tools: [],
    messages: [
      {
        id: "unrelated",
        order: 0,
        role: "user",
        text: "Inspect my file",
        turnId: "other-turn",
      },
      {
        id: ids[0]!,
        order: 1,
        role: "user",
        text: "Inspect my file",
        turnId: "local-turn",
        images: [{ mimeType: "image/png", data: image.data, reference: 3 }],
      },
    ],
  };
  commitHistory(conversation, staged);
  assert.deepEqual(
    conversation.messages.map(({ turnId }) => turnId),
    ["local-turn", "local-turn"],
  );
  assert.equal(conversation.messages[0]!.images?.[0]?.reference, 3);
});
