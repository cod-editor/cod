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

    const stateFile = path.join(app.data, "state.json");
    const saved = async () =>
      JSON.parse(
        await readFile(stateFile, "utf8"),
      ) as import("../../src/types").AppState;
    await app.app!.evaluate((_, stateFile) => {
      const fs = process.getBuiltinModule("node:fs/promises")!;
      const rename = fs.rename;
      let armed = false;
      let release: ((reject: boolean) => void) | undefined;
      Object.assign(globalThis, {
        navigationCheckpoint: {
          arm: () => {
            armed = true;
          },
          waiting: () => !!release,
          finish: (reject: boolean) => {
            armed = false;
            release?.(reject);
            release = undefined;
          },
        },
      });
      fs.rename = async (from, to) => {
        if (armed && String(to) === stateFile) {
          armed = false;
          const reject = await new Promise<boolean>((resolve) => {
            release = resolve;
          });
          if (reject) throw new Error("Invented checkpoint failure");
        }
        return rename(from, to);
      };
    }, stateFile);
    const checkpoint = (action: "arm" | "waiting" | "finish", reject = false) =>
      app.app!.evaluate(
        (_, { action, reject }) => {
          const scope = globalThis as unknown as {
            navigationCheckpoint: {
              arm: () => void;
              waiting: () => boolean;
              finish: (reject: boolean) => void;
            };
          };
          return scope.navigationCheckpoint[action](reject);
        },
        { action, reject },
      );
    try {
      await app.overview();
      await checkpoint("arm");
      await app.row("Invented other task").click();
      await expect.poll(() => checkpoint("waiting")).toBe(true);
      await expect(
        app.page.getByRole("button", { name: "Overview", exact: true }),
      ).toHaveText("Invented other task");
      expect((await saved()).activeWorkspaceId).toBe(main);
      await checkpoint("finish");
      await expect
        .poll(async () => (await saved()).activeWorkspaceId)
        .toBe(other);
      await expect(
        app.page.getByRole("textbox", { name: "Message", exact: true }),
      ).toBeFocused();
      await app.cli("workspace", "focus", "--id", main);

      await checkpoint("arm");
      await toggle().click();
      await expect.poll(() => checkpoint("waiting")).toBe(true);
      await expect(toggle()).toHaveAttribute("aria-pressed", "false");
      const collapsed = async () =>
        (await saved()).workspaces
          .find((w) => w.id === main)
          ?.groups.some((group) => group.hidden);
      expect(await collapsed()).toBe(false);
      await checkpoint("finish");
      await expect.poll(collapsed).toBe(true);

      const tab = (id: string) =>
        app.page.locator(`[role="tab"][data-tab-id="${id}"]`);
      await checkpoint("arm");
      await tab(file.paneId).click();
      await expect.poll(() => checkpoint("waiting")).toBe(true);
      await expect(tab(file.paneId)).toHaveAttribute("aria-selected", "true");
      expect(
        (await saved()).workspaces.find((w) => w.id === main)?.activePaneId,
      ).toBe(initial.activePaneId);
      await checkpoint("finish", true);
      await expect(tab(initial.activePaneId)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(tab(file.paneId)).toHaveAttribute("aria-selected", "false");
    } finally {
      await checkpoint("finish");
    }
    await app.stop();
    await app.start();
    await expect(
      app.page.getByRole("button", { name: "Overview", exact: true }),
    ).toHaveText("Invented main task");
    await expect(toggle()).toHaveAttribute("aria-pressed", "false");
    await expect(app.pane(initial.activePaneId)).toBeVisible();
  } finally {
    await app.cleanup();
  }
});
