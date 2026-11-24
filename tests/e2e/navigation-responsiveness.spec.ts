import {
  openWorkspaceState,
  readWorkspaceState,
  writeWorkspaceState,
} from "../support/workspace-state";
import { test, expect } from "@playwright/test";
import { ChatApp } from "./helpers/chat-fixture/harness";

test("Long conversations open a recent window, preserve earlier messages and search the complete history", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const workspace = await app.create("Invented history workspace");
    const chat = await app.newChat(workspace, "codex");
    await app.stop();
    const state = readWorkspaceState(app.data);
    const conversation = state.conversations.find(
      (item) => item.id === chat.id,
    )!;
    conversation.messages = Array.from({ length: 200 }, (_, index) => ({
      id: `invented-${index}`,
      role: index % 2 ? "assistant" : "user",
      origin: "application",
      order: index,
      text: `${index === 0 ? "Oldest invented marker" : index === 199 ? "Latest invented marker" : "Invented message " + index}\n\n${"Invented history. ".repeat(150)}`,
    }));
    writeWorkspaceState(app.data, state);
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

test("Layout selection renders during the state checkpoint and rolls back a failed save", async () => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const main = await app.create("Invented main task");
    const initial = await app.workspace(main);
    const file = await app.cli<{ paneId: string }>(
      "file",
      "new",
      "--workspace",
      main,
      "--group",
      initial.activeGroupId,
    );
    await app.cli(
      "pane",
      "focus",
      "--workspace",
      main,
      "--id",
      initial.activePaneId,
    );
    const other = await app.create("Invented other task");
    await app.cli("workspace", "focus", "--id", main);
    const toggle = () =>
      app.page.getByRole("button", {
        name: "Toggle split view",
        exact: true,
      });
    await toggle().click();
    await app.cli("workspace", "focus", "--id", main);
    await expect(toggle()).toHaveAttribute("aria-pressed", "true");

    const saved = () => readWorkspaceState(app.data);
    const active = () => saved().workspaces.find((w) => w.id === main)!;
    const files = () =>
      app.page.getByRole("button", {
        name: "Toggle files",
        exact: true,
      });
    const filesVisible = () => active().settings?.filesVisible === true;
    const initialFiles = filesVisible();

    // Hold the writer lock while checking that the UI updates and the durable
    // state does not. The worker has a bounded busy timeout.
    const whileWriteLocked = async (check: () => Promise<void>) => {
      using db = openWorkspaceState(app.data);
      db.exec("BEGIN IMMEDIATE");
      try {
        await check();
      } finally {
        db.exec("ROLLBACK");
      }
    };
    await app.overview();
    await whileWriteLocked(async () => {
      await app.row("Invented other task").click();
      await expect(
        app.page.getByRole("button", { name: "Overview", exact: true }),
      ).toHaveText("Invented other task");
      expect(saved().activeWorkspaceId).toBe(main);
    });
    await expect.poll(() => saved().activeWorkspaceId).toBe(other);
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeFocused();
    await app.cli("workspace", "focus", "--id", main);

    const collapsed = () => active().groups.some((group) => group.hidden);
    await whileWriteLocked(async () => {
      await toggle().click();
      await expect(toggle()).toHaveAttribute("aria-pressed", "false");
      expect(collapsed()).toBe(false);
    });
    await expect.poll(collapsed).toBe(true);

    await whileWriteLocked(async () => {
      await files().click();
      await expect(files()).toHaveAttribute(
        "aria-pressed",
        String(!initialFiles),
      );
      expect(filesVisible()).toBe(initialFiles);
    });
    await expect.poll(filesVisible).toBe(!initialFiles);

    const tab = (id: string) =>
      app.page.locator(`[role="tab"][data-tab-id="${id}"]`);
    {
      using db = openWorkspaceState(app.data);
      db.exec(`
        CREATE TRIGGER fail_navigation_checkpoint BEFORE UPDATE ON records
        WHEN NEW.kind = 'workspace'
          AND json_extract(NEW.body, '$.activePaneId') = '${file.paneId}'
        BEGIN
          SELECT RAISE(ABORT, 'Invented checkpoint failure');
        END;
      `);
      try {
        await whileWriteLocked(async () => {
          await tab(file.paneId).click();
          await expect(tab(file.paneId)).toHaveAttribute(
            "aria-selected",
            "true",
          );
          expect(active().activePaneId).toBe(initial.activePaneId);
        });
        await expect(tab(initial.activePaneId)).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect(tab(file.paneId)).toHaveAttribute(
          "aria-selected",
          "false",
        );
        expect(active().activePaneId).toBe(initial.activePaneId);
      } finally {
        db.exec("DROP TRIGGER fail_navigation_checkpoint");
      }
    }
    await app.stop();
    await app.start();
    await expect(
      app.page.getByRole("button", { name: "Overview", exact: true }),
    ).toHaveText("Invented main task");
    await expect(toggle()).toHaveAttribute("aria-pressed", "false");
    await expect(files()).toHaveAttribute(
      "aria-pressed",
      String(!initialFiles),
    );
    await expect(app.pane(initial.activePaneId)).toBeVisible();
  } finally {
    await app.cleanup();
  }
});
