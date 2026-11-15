import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppState } from "../../src/types";
import { ChatApp } from "./helpers/chat-fixture/harness";

let shell: ChatApp;
test.beforeEach(async () => {
  shell = new ChatApp();
  await shell.prepare();
  await shell.start();
});
test.afterEach(async () => {
  await shell?.cleanup();
});

test("Kimi completion retains its last text outside collapsed tools even when cleanup tools follow", async () => {
  await shell.configure({ kimi: { noFinalReply: true } });
  const workspace = await shell.create("Visible reply");
  const chat = await shell.newChat(workspace, "kimi");
  await shell.send(chat.id, "Invented progress summary");
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("ready");
  const transcript = shell
    .pane(chat.paneId)
    .getByRole("region", { name: "Conversation transcript" });
  await expect(transcript.locator(":scope > .assistant")).toContainText(
    "STREAM Invented progress summary",
  );
  await expect(transcript.locator("details.turn-activity")).not.toHaveAttribute(
    "open",
    "",
  );
  await shell.page.screenshot({
    path: test.info().outputPath("last-kimi-text.png"),
  });
  await shell.stop();
  await shell.start();
  await shell.cli("conversation", "show", "--id", chat.id);
  await expect(
    shell.pane(chat.paneId).locator(".transcript > .assistant"),
  ).toContainText("STREAM Invented progress summary");
});

test("Kimi empty completion shows an error and old empty completed turns show a missing-reply notice", async () => {
  await shell.configure({ kimi: { emptyReply: true } });
  const workspace = await shell.create("Missing reply");
  const chat = await shell.newChat(workspace, "kimi");
  await shell.send(chat.id, "Invented status question");
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("failed");
  await expect(
    shell
      .pane(chat.paneId)
      .getByRole("status", { name: "Conversation status", exact: true }),
  ).toContainText("Kimi returned no response");
  await shell.stop();
  // Reproduce a completion saved by older Cod builds, which trusted end_turn.
  const file = path.join(shell.data, "state.json");
  const state = JSON.parse(await readFile(file, "utf8")) as AppState;
  const saved = state.conversations.find((item) => item.id === chat.id)!;
  saved.status = "ready";
  saved.error = undefined;
  saved.messages = saved.messages.filter((message) => message.role === "user");
  saved.turns!.at(-1)!.outcome = "completed";
  await writeFile(file, JSON.stringify(state));
  await shell.start();
  await expect(
    shell
      .pane(chat.paneId)
      .getByText("Agent finished without a text reply.", { exact: true }),
  ).toBeVisible();
});
