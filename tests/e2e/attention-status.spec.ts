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
    const row = () => shell.page.locator(`[data-workspace-id="${chat.id}"]`);
    const workspaceRow = () =>
      shell.page.locator(`[data-workspace-id="${workspace}"]`);
    const badge = () => row().locator(".attention");
    const workspaceBadge = () => workspaceRow().locator(".attention");
    const quiet = async () => {
      await expect(badge()).toHaveCount(0);
      await expect(workspaceBadge()).toHaveCount(0);
    };
    const ready = async () => {
      await expect
        .poll(async () => (await shell.inspect(chat.id)).status)
        .toBe("ready");
      await expect(badge()).toHaveText("○");
      await expect(workspaceBadge()).toHaveText("○");
      await expect(workspaceBadge()).toHaveAttribute("title", "ready");
    };
    await quiet();
    await shell.send(chat.id, "First completed answer");
    await ready();
    await row().click();
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
  const row = () => shell.page.locator(`[data-workspace-id="${chat.id}"]`);
  const badge = () => row().locator(".attention");
  const reviewVisible = async () => {
    await expect(row()).toHaveAttribute("data-status", "review");
    await expect(badge()).toHaveAttribute("title", "review");
    await expect(badge().locator("svg")).toBeVisible();
    const workspaceBadge = shell.page.locator(
      `[data-workspace-id="${workspace}"] .attention`,
    );
    await expect(workspaceBadge).toHaveAttribute("title", "review");
    await expect(workspaceBadge.locator("svg")).toBeVisible();
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
  await row().click();
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
  await expect(badge()).toHaveText("○");
  await shell.cli("conversation", "acknowledge", "--id", chat.id);
  await expect(badge()).toHaveCount(0);
});
