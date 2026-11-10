import { test, expect } from "@playwright/test";
import { ChatApp } from "./helpers/chat-fixture/harness";
let app: ChatApp;
test.beforeEach(async () => {
  app = new ChatApp();
  await app.prepare();
  await app.start();
});
test.afterEach(async () => {
  await app?.cleanup();
});

for (const provider of ["codex", "kimi"] as const) {
  test(`CLI context follows ${provider} conversation ownership through move and restart`, async () => {
    const source = await app.create("Owned context");
    const chat = await app.newChat(source, provider);
    await app.send(chat.id, "PRIVATE_TRANSCRIPT_SENTINEL");
    await expect
      .poll(async () => (await app.inspect(chat.id)).status)
      .toBe("ready");
    const other = await app.create("Other context");
    app.environment.COD_CONVERSATION_ID = chat.id;
    app.environment.COD_WORKSPACE_ID = source;
    const context = () =>
      app.cli<{
        workspace: { id: string };
        conversation: { id: string; nativeId: string };
      }>("context");
    const initial = await context();
    expect(initial.workspace.id).toBe(source);
    expect(initial.conversation.id).toBe(chat.id);
    expect(JSON.stringify(initial)).not.toContain(
      "PRIVATE_TRANSCRIPT_SENTINEL",
    );
    expect(JSON.stringify(initial)).not.toContain("Other context");
    await app.cli(
      "conversation",
      "move",
      "--id",
      chat.id,
      "--workspace",
      other,
      "--follow",
      "false",
    );
    expect((await context()).workspace.id).toBe(other);
    await app.stop();
    await app.start();
    const restored = await context();
    expect(restored.workspace.id).toBe(other);
    expect(restored.conversation.nativeId).toBe(initial.conversation.nativeId);
    delete app.environment.COD_CONVERSATION_ID;
    expect((await app.raw("context")).code).not.toBe(0);
    expect(await app.cli("context", "--conversation", chat.id)).toEqual(
      restored,
    );
    expect(
      (await app.raw("context", "--conversation", "missing")).code,
    ).not.toBe(0);
  });
}

test("Runtime AC3 help covers actual capabilities and normal file operations remain reachable", async () => {
  const help = (await app.raw("--help")).stdout;
  const caps = await app.cli<{ operations: string[] }>("capabilities");
  for (const operation of caps.operations)
    expect(help).toContain(operation.replace(".", " "));
  const workspace = await app.create("Runtime file fixture");
  const pane = await app.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    app.file,
  );
  const current = await app.cli<{ content: string }>(
    "file",
    "read",
    "--workspace",
    workspace,
    "--pane-id",
    pane.paneId,
  );
  expect(current.content).toContain("Invented");
  expect(
    await app.cli(
      "file",
      "save",
      "--workspace",
      workspace,
      "--pane-id",
      pane.paneId,
      "--content",
      "",
      "--expected-content",
      current.content,
    ),
  ).toEqual({ saved: true, conflict: false });
  expect(
    await app.cli(
      "file",
      "read",
      "--workspace",
      workspace,
      "--pane-id",
      pane.paneId,
    ),
  ).toEqual({ content: "" });
});
