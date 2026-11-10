import { test, expect } from "@playwright/test";
import path from "node:path";
import {
  RuntimeApp,
  ContextClient,
  toolPayload,
  alive,
} from "../runtime-integration/harness";
let app: RuntimeApp;
test.beforeEach(async () => {
  app = new RuntimeApp();
  await app.prepare();
  await app.start();
});
test.afterEach(async () => {
  await app?.cleanup();
});

for (const provider of ["codex", "kimi"] as const) {
  test(`Runtime AC1/4 ${provider}: additive packaged MCP initializes before bind and resumes with owned cleanup`, async () => {
    const workspace = await app.create("Bound runtime fixture");
    const chat = await app.newChat(workspace, provider);
    const check = async () => {
      const records = await app.contextRecords();
      const binding = records
        .filter((r) => r.event === "context-descriptor")
        .at(-1)!;
      expect(binding.descriptor).toBeTruthy();
      const descriptor = binding.descriptor!;
      expect(descriptor.name).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(path.isAbsolute(descriptor.command)).toBe(true);
      expect(descriptor.args).toContain(path.join(app.root, "dist/cli.cjs"));
      expect(descriptor.args).toContain("context-server");
      expect(descriptor.args[descriptor.args.indexOf("--workspace") + 1]).toBe(
        workspace,
      );
      expect(
        descriptor.args[descriptor.args.indexOf("--conversation") + 1],
      ).toBe(chat.id);
      expect(descriptor.env.COD_SOCKET_PATH).toBe(app.socket);
      expect(descriptor.env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(binding.providerNodeMode).toBeNull();
      expect(JSON.stringify(descriptor)).not.toContain("PRIVATE_ENV_SENTINEL");
      expect(binding.params).not.toHaveProperty("model");
      expect(binding.params).not.toHaveProperty("developerInstructions");
      const registered = records
        .filter((r) => r.event === "context-registered")
        .at(-1)!;
      expect(registered.tools).toEqual(["cod_context", "cod_help"]);
      expect(alive(registered.childPid!)).toBe(true);
      return registered.childPid!;
    };
    const firstPid = await check();
    await app.stop();
    await expect.poll(() => alive(firstPid)).toBe(false);
    await app.start();
    expect((await app.inspect(chat.id)).nativeId).toBe(chat.nativeId);
    await app.send(chat.id, "Invented runtime resume");
    await expect
      .poll(async () => (await app.inspect(chat.id)).status)
      .toBe("ready");
    const resumedPid = await check();
    expect(resumedPid).not.toBe(firstPid);
    await app.cli("workspace", "close", "--id", workspace);
    await expect.poll(() => alive(resumedPid)).toBe(false);
  });
}

test("Runtime AC2 real CLI MCP follows conversation ownership, excludes private state and rejects missing targets", async () => {
  const workspace = await app.create("Bound fixture");
  const chat = await app.newChat(workspace, "codex");
  await app.send(chat.id, "PRIVATE_TRANSCRIPT_SENTINEL");
  await expect
    .poll(async () => (await app.inspect(chat.id)).status)
    .toBe("ready");
  const other = await app.create("OTHER_WORKSPACE_SENTINEL");
  const client = new ContextClient(app, workspace, chat.id);
  try {
    expect((await client.initialize()).result?.protocolVersion).toBe(
      "2025-11-25",
    );
    expect(
      (await client.request("tools/list")).result?.tools?.map((t) => t.name),
    ).toEqual(["cod_context", "cod_help"]);
    const context = toolPayload(
      await client.request("tools/call", {
        name: "cod_context",
        arguments: {},
      }),
    );
    expect(context.workspace).toMatchObject({
      id: workspace,
      name: "Bound fixture",
    });
    expect(context.conversation).toMatchObject({
      id: chat.id,
      nativeId: chat.nativeId,
    });
    expect(JSON.stringify(context)).not.toMatch(
      /PRIVATE_TRANSCRIPT_SENTINEL|PRIVATE_ENV_SENTINEL|OTHER_WORKSPACE_SENTINEL/,
    );
    const help = toolPayload(
      await client.request("tools/call", { name: "cod_help", arguments: {} }),
    );
    expect(help.helpText).toBe((await app.raw("--help")).stdout);
    expect(help.capabilities).toEqual(await app.cli("capabilities"));
    await app.cli("workspace", "close", "--id", workspace);
    expect(
      (
        await client.request("tools/call", {
          name: "cod_context",
          arguments: {},
        })
      ).result?.isError,
    ).toBe(true);
    await client.close();
  } finally {
    await client.cleanup();
  }
  const otherChat = await app.newChat(other, "kimi");
  const different = await app.create("Different existing workspace");
  const mismatch = new ContextClient(app, different, otherChat.id);
  try {
    await mismatch.initialize();
    const resolved = toolPayload(
      await mismatch.request("tools/call", {
        name: "cod_context",
        arguments: {},
      }),
    );
    expect(resolved.workspace).toMatchObject({ id: other });
    expect(resolved.conversation).toMatchObject({ id: otherChat.id });
    expect(JSON.stringify(resolved)).not.toContain(
      "Different existing workspace",
    );
  } finally {
    await mismatch.cleanup();
  }
});

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
