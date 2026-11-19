import { test, expect } from "@playwright/test";
import { ChatApp } from "./helpers/chat-fixture/harness";

let shell: ChatApp;
test.beforeEach(async () => {
  shell = new ChatApp();
  await shell.prepare();
  await shell.configure({ codex: { options: true }, kimi: { options: true } });
  await shell.start();
});
test.afterEach(async () => shell?.cleanup());

for (const provider of ["codex", "kimi"] as const) {
  test(`${provider} ready attention acknowledges through UI and CLI, survives restart and returns only for a new completion`, async ({}, info) => {
    const workspace = await shell.create(`${provider} completion attention`);
    const chat = await shell.newChat(workspace, provider);
    const row = () =>
      shell.page.locator(
        `.overview-row[data-navigation-key="conversation:${chat.id}"]`,
      );
    const workspaceRow = () =>
      shell.page.locator(
        `.overview-row[data-navigation-key="workspace:${workspace}"]`,
      );

    const quiet = async () => {
      await shell.overview();
      await expect(row()).toHaveAttribute("data-status", "");
      await expect(workspaceRow()).toHaveAttribute("data-status", "");
    };
    const ready = async () => {
      await shell.overview();
      await expect
        .poll(async () => (await shell.inspect(chat.id)).status)
        .toBe("ready");
      await expect(row()).toHaveAttribute("data-status", "ready");
      await expect(workspaceRow()).toHaveAttribute("data-status", "ready");
      await expect(row().locator(".overview-item")).toHaveAttribute(
        "aria-label",
        /Completed/,
      );
      await expect(workspaceRow().locator(".overview-item")).toHaveAttribute(
        "aria-label",
        /Completed/,
      );
    };
    await quiet();
    await shell.send(chat.id, "First completed answer");
    await ready();
    await row().locator(".overview-item").click();
    await quiet();
    await shell.cli("conversation", "options", "--id", chat.id);
    await quiet();
    await shell.stop();
    await shell.start();
    await quiet();
    await shell.cli("conversation", "options", "--id", chat.id);
    await quiet();
    await shell.send(chat.id, "Second completed answer");
    await ready();
    await shell.page.screenshot({
      path: info.outputPath(`${provider}-new-completion-ready.png`),
    });
    await shell.stop();
    await shell.start();
    await ready();
    await shell.cli("conversation", "acknowledge", "--id", chat.id);
    await quiet();
    const before = await shell.cli<{ completionRevision?: number }>(
      "conversation",
      "inspect",
      "--id",
      chat.id,
    );
    await shell.send(chat.id, "[hold] Cancelled work is not a new result");
    await expect
      .poll(async () => (await shell.inspect(chat.id)).status)
      .toBe("working");
    await shell.page.keyboard.press("Escape");
    await shell
      .pane(chat.paneId)
      .getByRole("button", { name: "Stop", exact: true })
      .click();
    await expect
      .poll(async () => (await shell.inspect(chat.id)).status)
      .toBe("ready");
    await quiet();
    expect(
      (
        await shell.cli<{ completionRevision?: number }>(
          "conversation",
          "inspect",
          "--id",
          chat.id,
        )
      ).completionRevision,
    ).toBe(before.completionRevision);
  });
}

test("Acknowledgment and native lifecycle preserve explicit plugin review status", async () => {
  const workspace = await shell.create("Explicit review attention");
  const chat = await shell.newChat(workspace, "codex");
  const row = () =>
    shell.page.locator(
      `.overview-row[data-navigation-key="conversation:${chat.id}"]`,
    );
  const workspaceRow = () =>
    shell.page.locator(
      `.overview-row[data-navigation-key="workspace:${workspace}"]`,
    );
  const reviewVisible = async () => {
    await shell.overview();
    await expect(row()).toHaveAttribute("data-status", "review");
    await expect(row().locator(".overview-item")).toHaveAttribute(
      "aria-label",
      /Review requested/,
    );
    await expect(row().locator(".navigation-item-icon")).toBeVisible();
    await expect(workspaceRow()).toHaveAttribute("data-status", "review");
    await expect(workspaceRow().locator(".overview-item")).toHaveAttribute(
      "aria-label",
      /Review requested/,
    );
    await expect(workspaceRow().locator(".navigation-item-icon")).toBeVisible();
  };
  await shell.cli(
    "conversation",
    "report-status",
    "--id",
    chat.id,
    "--status",
    "review",
  );
  await reviewVisible();
  await row().locator(".overview-item").click();
  await reviewVisible();
  await shell.cli(
    "conversation",
    "report-status",
    "--id",
    chat.id,
    "--status",
    "ready",
    "--source",
    "hook",
  );
  await shell.cli("conversation", "options", "--id", chat.id);
  await shell.send(
    chat.id,
    "Complete native work while review is still pending",
  );
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("ready");
  await reviewVisible();
  await shell.stop();
  await shell.start();
  await reviewVisible();
  expect(
    (
      await shell.cli<{ taskStatus?: string }>(
        "conversation",
        "inspect",
        "--id",
        chat.id,
      )
    ).taskStatus,
  ).toBe("review");
  await shell.cli(
    "conversation",
    "report-status",
    "--id",
    chat.id,
    "--status",
    "ready",
  );
  await expect(row()).toHaveAttribute("data-status", "ready");
  await shell.cli("conversation", "acknowledge", "--id", chat.id);
  await expect(row()).toHaveAttribute("data-status", "");
});
