import { test, expect } from "@playwright/test";
import type { AppState } from "../../src/types";
import { ChatApp } from "./helpers/chat-fixture/harness";
let shell: ChatApp;
test.beforeEach(async () => {
  shell = new ChatApp();
  await shell.prepare();
  await shell.start();
});
test.afterEach(async () => {
  await shell.cleanup();
});
const pixel = {
  reference: 1,
  mimeType: "image/png",
  name: "invented.png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=",
};
async function draft(workspace: string, paneId: string) {
  return (await shell.cli<AppState>("state")).workspaces.find(
    (w) => w.id === workspace,
  )?.chatDrafts?.[paneId];
}

test("CLI composer updates reach an already hydrated chat with images and skills", async () => {
  const workspace = await shell.create("External draft fixture");
  const chat = await shell.newChat(workspace, "codex");
  const input = shell
    .pane(chat.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  await shell.cli(
    "conversation",
    "composer",
    "--workspace",
    workspace,
    "--pane-id",
    chat.paneId,
    "--text",
    "External $example [Image 1]",
    "--images",
    JSON.stringify([pixel]),
    "--skills",
    JSON.stringify([{ name: "example", path: shell.file }]),
  );
  await expect(input).toHaveValue("External $example [Image 1]");
  await expect(
    shell.pane(chat.paneId).locator(".composer-images img"),
  ).toHaveCount(1);
  await input.fill("Updated locally $example [Image 1]");
  await expect
    .poll(async () => (await draft(workspace, chat.paneId))?.text)
    .toBe("Updated locally $example [Image 1]");
  expect((await draft(workspace, chat.paneId))?.skills).toEqual([
    { name: "example", path: shell.file },
  ]);
  await shell.create("Another fixture task");
  await shell.cli("workspace", "focus", "--id", workspace);
  await expect(input).toHaveValue("Updated locally $example [Image 1]");
  await shell.cli(
    "conversation",
    "composer",
    "--workspace",
    workspace,
    "--pane-id",
    chat.paneId,
    "--text",
    "Second external draft",
    "--images",
    "[]",
    "--skills",
    "[]",
  );
  await expect(input).toHaveValue("Second external draft");
  await expect(
    shell.pane(chat.paneId).locator(".composer-images img"),
  ).toHaveCount(0);
  await input.press("Enter");
  await expect
    .poll(async () =>
      (await shell.inspect(chat.id)).messages
        .filter((m) => m.role === "user")
        .map((m) => m.text),
    )
    .toContain("Second external draft");
  await expect(input).toHaveValue("");
  await input.fill("Next local draft");
  await expect
    .poll(async () => (await draft(workspace, chat.paneId))?.text)
    .toBe("Next local draft");
  await expect(
    shell.page.getByRole("region", { name: "Draft conflict" }),
  ).toHaveCount(0);
});

for (const choice of ["Keep my draft", "Use external draft"])
  test(`Concurrent composer changes survive restart and resolve with ${choice}`, async ({}, info) => {
    const workspace = await shell.create("Conflicting draft fixture");
    const chat = await shell.newChat(workspace, "codex");
    let input = shell
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
    await expect(input).toBeEnabled();
    await shell.cli(
      "conversation",
      "composer",
      "--workspace",
      workspace,
      "--pane-id",
      chat.paneId,
      "--text",
      "Baseline [Image 2]",
      "--images",
      JSON.stringify([{ ...pixel, reference: 2, name: "local.png" }]),
    );
    await expect(input).toHaveValue("Baseline [Image 2]");
    // A second writer commits before the local keystroke can be saved. Both use
    // production IPC and persistence; no provider inference is needed for the race.
    await input.evaluate(
      async (node, { workspace, paneId, pixel }) => {
        const external = window.cod.invoke({
          op: "conversation.composer",
          workspace,
          paneId,
          text: "External evidence [Image 1]",
          images: [pixel],
          writer: "invented-other-window",
        });
        const field = node as HTMLTextAreaElement;
        field.value = "My unsent local edits [Image 2]";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        await external;
      },
      { workspace, paneId: chat.paneId, pixel },
    );
    const conflict = () =>
      shell.pane(chat.paneId).getByRole("region", { name: "Draft conflict" });
    await expect(conflict()).toBeVisible();
    await expect(input).toHaveValue("My unsent local edits [Image 2]");
    await shell
      .pane(chat.paneId)
      .screenshot({ path: info.outputPath("composer-conflict.png") });
    await expect
      .poll(async () => (await draft(workspace, chat.paneId))?.localDraft?.text)
      .toBe("My unsent local edits [Image 2]");
    await input.fill("My revised local edits [Image 2]");
    await expect
      .poll(async () => (await draft(workspace, chat.paneId))?.localDraft?.text)
      .toBe("My revised local edits [Image 2]");
    await shell.cli(
      "conversation",
      "composer",
      "--workspace",
      workspace,
      "--pane-id",
      chat.paneId,
      "--text",
      "Later external evidence [Image 1]",
      "--images",
      JSON.stringify([pixel]),
    );
    await expect(input).toHaveValue("My revised local edits [Image 2]");
    await input.press("Enter");
    expect((await shell.inspect(chat.id)).messages).toHaveLength(0);
    await shell.stop();
    await shell.start();
    input = shell
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
    await expect(input).toHaveValue("My revised local edits [Image 2]");
    await expect(conflict()).toBeVisible();
    await conflict().getByRole("button", { name: choice, exact: true }).click();
    await expect(conflict()).toHaveCount(0);
    await expect(input).toHaveValue(
      choice === "Keep my draft"
        ? "My revised local edits [Image 2]"
        : "Later external evidence [Image 1]",
    );
    await expect
      .poll(async () => (await draft(workspace, chat.paneId))?.localDraft)
      .toBeUndefined();
    await expect(
      shell.pane(chat.paneId).locator(".composer-images img"),
    ).toHaveCount(1);
    await expect(
      shell.pane(chat.paneId).locator(".composer-images .image-reference"),
    ).toHaveText(choice === "Keep my draft" ? "[Image 2]" : "[Image 1]");
    await shell.stop();
    await shell.start();
    input = shell
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
    await expect(input).toHaveValue(
      choice === "Keep my draft"
        ? "My revised local edits [Image 2]"
        : "Later external evidence [Image 1]",
    );
  });

test("CLI updates an already open new-chat draft including its provider", async () => {
  const workspace = await shell.create("New draft fixture");
  const opened = await shell.cli<{ paneId: string }>(
    "conversation",
    "draft",
    "--workspace",
    workspace,
  );
  const input = shell
    .pane(opened.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  await shell.cli(
    "conversation",
    "composer",
    "--workspace",
    workspace,
    "--pane-id",
    opened.paneId,
    "--text",
    "Draft for Kimi [Image 1]",
    "--provider",
    "kimi",
    "--images",
    JSON.stringify([pixel]),
  );
  await expect(input).toHaveValue("Draft for Kimi [Image 1]");
  await expect(input).toHaveAttribute("placeholder", "Message Kimi...");
  await expect(
    shell.pane(opened.paneId).locator(".composer-images img"),
  ).toHaveCount(1);
  await input.press("Enter");
  await expect
    .poll(async () =>
      (await shell.cli<AppState>("state")).conversations
        .filter((c) => c.workspaceId === workspace)
        .map((c) => c.provider),
    )
    .toEqual(["kimi"]);
});
