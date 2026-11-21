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

test("Streaming reuses unchanged Markdown and keeps the final answer when its activity row closes", async () => {
  await shell.configure({
    codex: { latencyChunks: 14, holdLatencyCompletion: true },
  });
  const workspace = await shell.create("Invented stream workspace");
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    shell.folders[0],
  );
  await writeFile(
    path.join(shell.folders[0], "invented-preview.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(
    chat.id,
    "[Invented earlier reference](https://example.invalid/)\n\n![Preview](invented-preview.png)",
  );
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("ready");
  const pane = shell.pane(chat.paneId);
  const transcript = pane.getByRole("region", {
    name: "Conversation transcript",
  });
  const earlier = transcript.locator(".chat-message.user").first();
  const link = earlier.getByRole("link", {
    name: "Invented earlier reference",
    exact: true,
  });
  const image = earlier.getByRole("button", {
    name: "View invented-preview.png",
  });
  await expect(image.locator("img")).toBeVisible();
  await link.focus();
  await shell.page.evaluate(() => {
    const scope = window as typeof window & { rebuiltHistory: number };
    scope.rebuiltHistory = 0;
    const parse = DOMParser.prototype.parseFromString;
    DOMParser.prototype.parseFromString = function (source, type) {
      if (String(source).includes("Invented earlier reference"))
        scope.rebuiltHistory++;
      return parse.call(this, source, type);
    };
  });
  await shell.send(chat.id, "[latency-fixture] move-to-final");
  const liveText = transcript.locator(
    ".live-activity .assistant .message-text",
  );
  await expect(liveText).toContainText(/inventedstream-14-/);
  await expect(link).toBeFocused();
  await liveText.evaluate((text) =>
    Object.assign(window, { fixtureLiveText: text }),
  );
  const input = pane.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Invented next draft");
  await input.press("End");
  await shell.configure({ codex: {} });
  const finalText = transcript
    .locator(":scope > .assistant .message-text")
    .last();
  await expect(finalText).toContainText(/inventedstream-14-/);
  expect(
    await finalText.evaluate(
      (text) =>
        text ===
        (window as typeof window & { fixtureLiveText: Element })
          .fixtureLiveText,
    ),
  ).toBe(true);
  await expect(input).toHaveValue("Invented next draft");
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((field: HTMLTextAreaElement) => field.selectionStart),
  ).toBe("Invented next draft".length);
  expect(
    await shell.page.evaluate(
      () =>
        (window as typeof window & { rebuiltHistory: number }).rebuiltHistory,
    ),
  ).toBe(0);
  await image.click();
  await expect(shell.page.getByRole("dialog").locator("img")).toBeVisible();
  await shell.page.keyboard.press("Escape");
  await expect(image).toBeFocused();
});
