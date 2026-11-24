import {
  readWorkspaceState,
  writeWorkspaceState,
} from "../support/workspace-state";
import { test, expect } from "@playwright/test";
import path from "node:path";
import { writeFile } from "node:fs/promises";
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
  const state = readWorkspaceState(shell.data);
  const saved = state.conversations.find((item) => item.id === chat.id)!;
  saved.status = "ready";
  saved.error = undefined;
  saved.messages = saved.messages.filter((message) => message.role === "user");
  saved.turns!.at(-1)!.outcome = "completed";
  writeWorkspaceState(shell.data, state);
  await shell.start();
  await expect(
    shell
      .pane(chat.paneId)
      .getByText("Agent finished without a text reply.", { exact: true }),
  ).toBeVisible();
});

test("Streaming keeps unmarked assistant text visible and reuses its Markdown when the turn completes", async () => {
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
  const liveText = transcript
    .locator(":scope > .assistant .message-text")
    .last();
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

test("An accepted in-flight follow-up keeps the next streamed reply between its tool blocks", async ({}, info) => {
  await shell.configure({
    codex: { steeringReply: true, holdSteeringReply: true },
  });
  const workspace = await shell.create("Invented export");
  const chat = await shell.newChat(workspace, "codex");
  const pane = shell.pane(chat.paneId);
  const transcript = pane.getByRole("region", {
    name: "Conversation transcript",
    exact: true,
  });
  const input = pane.getByRole("textbox", { name: "Message", exact: true });
  const progress = transcript.getByRole("status", { name: "Turn activity" });
  const user = "Please confirm the export format.";
  const partial = "I'll check the export format";
  const full = partial + " while the export continues.";
  const final = "Export verified. The file is ready.";
  const rows = transcript.locator(":scope > .chat-message");
  const reply = rows.filter({ hasText: partial }).locator(".message-text");
  const activity = transcript.locator(":scope > details.turn-activity");
  const original = activity.filter({
    has: shell.page.locator('[title="echo invented-tool"]'),
  });
  const before = activity.filter({
    has: shell.page.locator('[title="echo before-follow-up-reply"]'),
  });
  const after = activity.filter({
    has: shell.page.locator('[title="node examples/export.mjs"]'),
  });
  const inspectOrder = (view = transcript) =>
    view.evaluate((element) =>
      [...element.children].map((node) =>
        [
          node.textContent,
          ...Array.from(
            node.querySelectorAll<HTMLElement>("summary[title]"),
            (summary) => summary.title,
          ),
        ].join(" "),
      ),
    );
  const expectOrder = async (texts: string[], view = transcript) => {
    const actual = await inspectOrder(view);
    let previous = -1;
    for (const text of texts) {
      const index = actual.findIndex((value) => value.includes(text));
      expect(index, `transcript order for ${text}`).toBeGreaterThan(previous);
      previous = index;
    }
  };

  await shell.send(chat.id, "Run the demo export [hold]");
  await expect(original).toBeAttached();
  await expect(original).not.toHaveAttribute("open", "");
  await expect(progress).toHaveText(/^Working/);
  await input.fill(user);
  await input.press("Enter");

  await expect(rows.filter({ hasText: user })).toBeVisible();
  await expect(reply).toHaveText(partial);
  await expect(reply).toBeVisible();
  await expect(progress).toHaveCount(1);
  await expect(original).not.toHaveAttribute("open", "");
  await expect(before).not.toHaveAttribute("open", "");
  await expectOrder([
    "STREAM Run the demo export",
    "echo invented-tool",
    user,
    "echo before-follow-up-reply",
    partial,
    "Working",
  ]);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await shell.page.screenshot({
    path: info.outputPath("accepted-follow-up.png"),
  });

  const originalSummary = original.locator(":scope > summary");
  await originalSummary.press("Enter");
  await expect(original).toHaveAttribute("open", "");
  await expect(originalSummary).toBeFocused();
  await input.fill("Invented unsent draft");
  await input.press("End");
  await shell.configure({ codex: { steeringReply: true } });
  await expect(reply).toHaveText(full);
  await expect(
    rows.getByText("Inspecting the generated sample.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(after).not.toHaveAttribute("open", "");
  await expect(original).toHaveAttribute("open", "");
  await expectOrder([
    user,
    partial,
    "Inspecting the generated sample.",
    "node examples/export.mjs",
  ]);
  await expect(progress).toHaveCount(1);
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("working");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Invented unsent draft");
  await expect
    .poll(() =>
      input.evaluate((field: HTMLTextAreaElement) => field.selectionStart),
    )
    .toBe("Invented unsent draft".length);
  await reply.evaluate((node) =>
    Object.assign(window, { fixtureFollowUp: node }),
  );
  await originalSummary.press("Enter");
  await expect(original).not.toHaveAttribute("open", "");
  await input.focus();

  await shell.page.setViewportSize({ width: 420, height: 650 });
  await expect(reply).toBeVisible();
  await shell.page.screenshot({
    path: info.outputPath("accepted-follow-up-working-narrow.png"),
  });
  await shell.configure({
    codex: { steeringReply: true, finishSteeringReply: true },
  });
  await expect(rows.filter({ hasText: final })).toBeVisible();
  await expect(reply).toHaveText(full);
  expect(
    await reply.evaluate(
      (node) =>
        node ===
        (window as Window & { fixtureFollowUp?: Element }).fixtureFollowUp,
    ),
  ).toBe(true);
  await expect(progress).toHaveCount(0);
  await expectOrder([user, partial, "Inspecting the generated sample.", final]);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Invented unsent draft");
  expect((await shell.prompts()).length).toBe(1);
  const requests = (await shell.records()).map(
    (record) => record.message?.method,
  );
  expect(requests.filter((method) => method === "turn/steer")).toHaveLength(1);
  expect(requests).not.toContain("turn/interrupt");

  await shell.stop();
  await shell.start();
  await shell.cli("conversation", "show", "--id", chat.id);
  const reopened = shell.pane(chat.paneId);
  const reopenedTranscript = reopened.getByRole("region", {
    name: "Conversation transcript",
    exact: true,
  });
  const reopenedRows = reopenedTranscript.locator(":scope > .chat-message");
  const reopenedReply = reopenedRows
    .filter({ hasText: partial })
    .locator(".message-text");
  await expect(reopenedReply).toHaveText(full);
  await expect(reopenedReply).toBeVisible();
  await expect(reopenedRows.filter({ hasText: final })).toBeVisible();
  await expect(
    reopened.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Invented unsent draft");
  await expectOrder(
    [user, partial, "Inspecting the generated sample.", "Worked for", final],
    reopenedTranscript,
  );
  await shell.page.screenshot({
    path: info.outputPath("accepted-follow-up-reopened.png"),
  });
});
