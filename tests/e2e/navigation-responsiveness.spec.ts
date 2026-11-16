import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChatApp } from "./helpers/chat-fixture/harness";

test("Long conversations open a recent window, preserve earlier messages and search the complete history", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const workspace = await app.create("Invented history workspace");
    const chat = await app.newChat(workspace, "codex");
    await app.stop();
    const file = path.join(app.data, "state.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    const conversation = state.conversations.find(
      (item: any) => item.id === chat.id,
    );
    conversation.messages = Array.from({ length: 200 }, (_, index) => ({
      id: `invented-${index}`,
      role: index % 2 ? "assistant" : "user",
      origin: "application",
      order: index,
      text: `${index === 0 ? "Oldest invented marker" : index === 199 ? "Latest invented marker" : "Invented message " + index}\n\n${"Invented history. ".repeat(150)}`,
    }));
    await writeFile(file, JSON.stringify(state));
    await app.start();
    const pane = app.pane(chat.paneId);
    await expect(
      pane.getByText("Latest invented marker", { exact: true }),
    ).toBeVisible();
    const initial = await pane.locator(".chat-message").count();
    expect(initial).toBeLessThanOrEqual(60);
    expect(initial).toBeGreaterThan(0);
    expect(
      await pane.getByText("Oldest invented marker", { exact: true }).count(),
    ).toBe(0);
    const input = pane.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("Invented unsent message");
    await input.evaluate((node: HTMLTextAreaElement) =>
      node.setSelectionRange(4, 11),
    );
    await pane
      .getByRole("button", { name: "Earlier messages", exact: true })
      .click();
    await expect
      .poll(() => pane.locator(".chat-message").count())
      .toBeGreaterThan(initial);
    await expect(input).toHaveValue("Invented unsent message");
    expect(
      await input.evaluate((node: HTMLTextAreaElement) => [
        node.selectionStart,
        node.selectionEnd,
      ]),
    ).toEqual([4, 11]);
    await input.focus();
    await app.page.keyboard.press(
      process.platform === "darwin" ? "Meta+f" : "Control+f",
    );
    const find = app.page.getByRole("textbox", {
      name: "Find in current content",
      exact: true,
    });
    await expect(find).toBeFocused();
    await find.fill("Oldest invented marker");
    await expect(
      app.page.getByRole("status", { name: "Find results" }),
    ).toHaveText("1 of 1");
    await expect(
      pane.getByText("Oldest invented marker", { exact: true }),
    ).toBeVisible();
    await app.page.keyboard.press("Escape");
    await expect(input).toHaveValue("Invented unsent message");
    await pane.screenshot({
      path: info.outputPath("conversation-history-window.png"),
    });
    expect((await app.inspect(chat.id)).messages.length).toBe(200);
  } finally {
    await app.cleanup();
  }
});
