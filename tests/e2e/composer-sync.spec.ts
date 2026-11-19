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

for (const choice of ["Keep my message", "Use saved version"])
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
      choice === "Keep my message"
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
    ).toHaveText(choice === "Keep my message" ? "[Image 2]" : "[Image 1]");
    await shell.stop();
    await shell.start();
    input = shell
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
    await expect(input).toHaveValue(
      choice === "Keep my message"
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

test("A delayed snapshot cannot roll back a single composer's acknowledged draft", async () => {
  const workspace = await shell.create("Delayed draft snapshot");
  const chat = await shell.newChat(workspace, "codex");
  const input = shell
    .pane(chat.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Older invented draft");
  await expect
    .poll(async () => (await draft(workspace, chat.paneId))?.text)
    .toBe("Older invented draft");

  // Capture a real snapshot containing the older autosave, then allow the
  // newer text-only autosave to acknowledge before delivering that snapshot.
  await shell.app!.evaluate(
    ({ BrowserWindow }, { workspace, paneId, conversationId }) => {
      const view = BrowserWindow.getAllWindows()[0].webContents;
      const send = view.send.bind(view);
      let held: unknown[] | undefined;
      view.send = (channel, ...args) => {
        if (channel === "cod:state") {
          const state = args[0] as AppState;
          const draft = state.workspaces.find((w) => w.id === workspace)
            ?.chatDrafts?.[paneId];
          const conversation = state.conversations.find(
            (c) => c.id === conversationId,
          );
          if (
            draft?.text === "Older invented draft" &&
            conversation?.displayName === "Delayed draft snapshot fixture"
          )
            held = args;
          return;
        }
        send(channel, ...args);
      };
      Object.assign(globalThis, {
        releaseOldDraftSnapshot: () => {
          if (!held) throw new Error("No draft snapshot was captured");
          view.send = send;
          send("cod:state", ...held);
        },
      });
    },
    { workspace, paneId: chat.paneId, conversationId: chat.id },
  );
  await shell.cli(
    "conversation",
    "rename",
    "--id",
    chat.id,
    "--name",
    "Delayed draft snapshot fixture",
  );
  await input.fill("Newer invented draft");
  await expect
    .poll(async () => (await draft(workspace, chat.paneId))?.text)
    .toBe("Newer invented draft");
  // Round-trip through the same renderer IPC before delivering the older
  // snapshot, so the completed autosave reply has reached the renderer.
  await shell.page.evaluate(() => window.cod.invoke({ op: "state" }));
  await shell.app!.evaluate(() =>
    (globalThis as any).releaseOldDraftSnapshot(),
  );
  await expect(
    shell.page.getByRole("tab", {
      name: "Delayed draft snapshot fixture",
      exact: true,
    }),
  ).toBeVisible();
  await expect(input).toHaveValue("Newer invented draft");
  await input.fill("Latest invented draft");
  await expect
    .poll(async () => {
      const saved = await draft(workspace, chat.paneId);
      return { text: saved?.text, conflict: Boolean(saved?.localDraft) };
    })
    .toEqual({ text: "Latest invented draft", conflict: false });
  await expect(
    shell.page.getByRole("region", { name: "Draft conflict" }),
  ).toHaveCount(0);
  await input.press("Enter");
  await expect
    .poll(async () =>
      (await shell.inspect(chat.id)).messages.some(
        (message) =>
          message.role === "user" && message.text === "Latest invented draft",
      ),
    )
    .toBe(true);
});

for (const queued of [false, true])
  test(`A single composer keeps its next message when ${queued ? "queueing" : "sending"} with delayed state delivery`, async () => {
    const workspace = await shell.create("Send autosave ordering");
    const chat = await shell.newChat(workspace, "codex");
    if (queued) {
      await shell.configure({ codex: { steering: "unsupported" } });
      await shell.send(chat.id, "[hold] Invented active request");
      await expect
        .poll(async () => (await shell.inspect(chat.id)).status)
        .toBe("working");
    }
    const input = shell
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
    await input.fill("First submitted message");
    await expect
      .poll(async () => (await draft(workspace, chat.paneId))?.text)
      .toBe("First submitted message");
    // Hold state notifications while keeping production operation responses and
    // disk writes real. IPC replies need not arrive after a rendered snapshot.
    await shell.app!.evaluate(({ webContents }) => {
      const view = webContents
        .getAllWebContents()
        .find((v) => v.getURL().endsWith("/index.html"))!;
      const send = view.send.bind(view);
      (globalThis as any).releaseComposerState = () => {
        view.send = send;
      };
      view.send = ((channel: string, ...args: any[]) => {
        if (channel !== "cod:state") send(channel, ...args);
      }) as typeof view.send;
    });
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await input.fill("My follow-up message");
    await expect
      .poll(async () => (await draft(workspace, chat.paneId))?.text)
      .toBe("My follow-up message");
    await expect(
      shell.pane(chat.paneId).getByRole("region", { name: "Draft conflict" }),
    ).toHaveCount(0);
    await shell.app!.evaluate(() => (globalThis as any).releaseComposerState());
    await shell.cli(
      "conversation",
      "rename",
      "--id",
      chat.id,
      "--name",
      "Ordering fixture",
    );
    await expect(input).toHaveValue("My follow-up message");
    await shell.stop();
    await shell.start();
    await expect(
      shell
        .pane(chat.paneId)
        .getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("My follow-up message");
  });

for (const { fails, addsImage } of [
  { fails: false, addsImage: false },
  { fails: true, addsImage: false },
  { fails: false, addsImage: true },
  { fails: true, addsImage: true },
])
  test(`Typing during ${fails ? "failed" : "pending"} admission keeps the next message and attachments${addsImage ? " added during admission" : ""}`, async ({}, info) => {
    const workspace = await shell.create("Admission fixture");
    const chat = await shell.newChat(workspace, "codex");
    const input = shell
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
    await shell.cli(
      "conversation",
      "composer",
      "--workspace",
      workspace,
      "--pane-id",
      chat.paneId,
      "--text",
      "Submitted evidence [Image 1]",
      "--images",
      JSON.stringify([pixel]),
    );
    await expect(input).toHaveValue("Submitted evidence [Image 1]");
    await shell.app!.evaluate(({ ipcMain }, fails) => {
      const original = (ipcMain as any)._invokeHandlers.get("cod:invoke");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      (globalThis as any).releaseAdmission = release;
      (globalThis as any).admissionStarted = false;
      ipcMain.removeHandler("cod:invoke");
      ipcMain.handle("cod:invoke", async (event, request) => {
        if (request.op === "conversation.send") {
          (globalThis as any).admissionStarted = true;
          await gate;
          if (fails) throw new Error("Invented admission failure");
        }
        return original(event, request);
      });
    }, fails);
    await input.press("Enter");
    await expect
      .poll(() =>
        shell.app!.evaluate(() => (globalThis as any).admissionStarted),
      )
      .toBe(true);
    await input.fill("Follow-up evidence [Image 1]");
    if (addsImage) {
      await input.evaluate((node, data) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File(
            [
              Uint8Array.from(atob(data), (character) =>
                character.charCodeAt(0),
              ),
            ],
            "next-evidence.png",
            { type: "image/png" },
          ),
        );
        node.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, pixel.data);
      await expect(
        shell.pane(chat.paneId).locator(".composer-images img"),
      ).toHaveCount(2);
    }
    const followUp = `Follow-up evidence [Image 1]${addsImage ? "[Image 2]" : ""}`;
    await input.press("Home");
    await input.press("ArrowRight");
    await expect
      .poll(async () => (await draft(workspace, chat.paneId))?.text)
      .toBe(followUp);
    await shell.app!.evaluate(() => (globalThis as any).releaseAdmission());
    await expect
      .poll(async () => (await draft(workspace, chat.paneId))?.text)
      .toBe(followUp);
    await expect(input).toHaveValue(followUp);
    await expect(input).toBeFocused();
    expect(
      await input.evaluate(
        (node) => (node as HTMLTextAreaElement).selectionStart,
      ),
    ).toBe(1);
    await expect(
      shell.pane(chat.paneId).getByRole("region", { name: "Draft conflict" }),
    ).toHaveCount(0);
    // The unchanged attachment was admitted with the submitted text only on
    // success; a failed admission retains it with the new unsent text.
    await expect(
      shell.pane(chat.paneId).locator(".composer-images img"),
    ).toHaveCount((fails ? 1 : 0) + (addsImage ? 1 : 0));
    if (fails) {
      await expect(shell.pane(chat.paneId)).toContainText(
        "Invented admission failure",
      );
      expect((await shell.inspect(chat.id)).messages).toHaveLength(0);
    }
    await shell
      .pane(chat.paneId)
      .screenshot({ path: info.outputPath("admission-composer.png") });
    await shell.stop();
    await shell.start();
    await expect(
      shell
        .pane(chat.paneId)
        .getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue(followUp);
    await expect(
      shell.pane(chat.paneId).locator(".composer-images img"),
    ).toHaveCount((fails ? 1 : 0) + (addsImage ? 1 : 0));
  });

test("Composer typing stays responsive with large history and an attachment", async ({}, info) => {
  const backgroundWorkspace = await shell.create("Retained history fixture");
  const background = await shell.newChat(backgroundWorkspace, "codex");
  const workspace = await shell.create("Responsive composer fixture");
  const chat = await shell.newChat(workspace, "codex");
  const image = {
    ...pixel,
    data: Buffer.concat([
      Buffer.from(pixel.data, "base64"),
      Buffer.alloc(1024 * 1024),
    ]).toString("base64"),
  };
  const initial = "Invented unsent message. ".repeat(2000);
  await shell.page.evaluate(
    ({ workspace, paneId, initial, image }) =>
      window.cod.invoke({
        op: "conversation.composer",
        workspace,
        paneId,
        text: initial,
        images: [image],
      }),
    { workspace, paneId: chat.paneId, initial, image },
  );
  await shell.stop();
  const stateFile = path.join(shell.data, "state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const conversation = state.conversations.find((c: any) => c.id === chat.id);
  conversation.messages = Array.from({ length: 120 }, (_, index) => ({
    id: `fixture-message-${index}`,
    role: index % 2 ? "assistant" : "user",
    text: "Invented history paragraph. ".repeat(100),
    order: index,
  }));
  // Apply pressure through a real retained conversation, not unknown fields
  // that no supported profile can create and UI projection cannot classify.
  const retained = state.conversations.find((c: any) => c.id === background.id);
  retained.messages = Array.from({ length: 120 }, (_, index) => ({
    id: `retained-message-${index}`,
    role: index % 2 ? "assistant" : "user",
    text: "Invented retained history. ".repeat(8400),
    order: index,
  }));
  await writeFile(stateFile, JSON.stringify(state));
  await shell.start();
  const input = shell
    .pane(chat.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toHaveValue(initial);
  await input.focus();
  await input.evaluate((node) => {
    const field = node as HTMLTextAreaElement;
    field.setSelectionRange(field.value.length, field.value.length);
    (window as any).composerInputFrames = [];
    field.addEventListener("input", () => {
      const start = performance.now();
      requestAnimationFrame(() =>
        (window as any).composerInputFrames.push(performance.now() - start),
      );
    });
  });
  await input.pressSequentially(" Follow-up message");
  for (let index = 0; index < 45; index++) await input.press("Backspace");
  const expected = (initial + " Follow-up message").slice(0, -45);
  await expect(input).toHaveValue(expected);
  await expect(input).toBeFocused();
  const samples = await shell.page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    return (window as any).composerInputFrames as number[];
  });
  expect(samples.length).toBe(63);
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  info.annotations.push({
    type: "input-to-frame-p95-ms",
    description: p95.toFixed(1),
  });
  const performanceFile = info.outputPath("composer-performance.json");
  await writeFile(
    performanceFile,
    JSON.stringify({
      samples: samples.length,
      p95Ms: p95,
      maxMs: sorted.at(-1),
    }),
  );
  await info.attach("composer-performance", {
    path: performanceFile,
    contentType: "application/json",
  });
  expect(p95).toBeLessThan(200);
  await expect
    .poll(async () => {
      const overlay = await readFile(
        path.join(shell.data, "composer-text.json"),
        "utf8",
      );
      return {
        text: (Object.values(JSON.parse(overlay).drafts) as any[]).find(
          (entry) => entry.pane === chat.paneId,
        )?.draft.text,
        bounded: overlay.length < 55000 && !overlay.includes(image.data),
      };
    })
    .toEqual({ text: expected, bounded: true });
  await expect(
    shell.pane(chat.paneId).getByRole("region", { name: "Draft conflict" }),
  ).toHaveCount(0);
});

test("An unseen external edit during send admission remains a genuine conflict", async () => {
  const workspace = await shell.create("External admission fixture");
  const chat = await shell.newChat(workspace, "codex");
  const input = shell
    .pane(chat.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await shell.cli(
    "conversation",
    "composer",
    "--workspace",
    workspace,
    "--pane-id",
    chat.paneId,
    "--text",
    "Original message",
  );
  await expect(input).toHaveValue("Original message");
  await shell.app!.evaluate(({ ipcMain, webContents }) => {
    const view = webContents
      .getAllWebContents()
      .find((v) => v.getURL().endsWith("/index.html"))!;
    const send = view.send.bind(view);
    view.send = ((channel: string, ...args: any[]) => {
      if (channel !== "cod:state") send(channel, ...args);
    }) as typeof view.send;
    const original = (ipcMain as any)._invokeHandlers.get("cod:invoke");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (globalThis as any).releaseAdmission = release;
    (globalThis as any).admissionStarted = false;
    ipcMain.removeHandler("cod:invoke");
    ipcMain.handle("cod:invoke", async (event, request) => {
      if (request.op === "conversation.send") {
        (globalThis as any).admissionStarted = true;
        await gate;
      }
      return original(event, request);
    });
  });
  await input.press("Enter");
  await expect
    .poll(() => shell.app!.evaluate(() => (globalThis as any).admissionStarted))
    .toBe(true);
  await input.evaluate(
    async (node, { workspace, paneId }) => {
      await window.cod.invoke({
        op: "conversation.composer",
        workspace,
        paneId,
        text: "Other writer message",
        writer: "invented-other-writer",
      });
      (node as HTMLTextAreaElement).value = "Local next message";
      node.dispatchEvent(new Event("input", { bubbles: true }));
    },
    { workspace, paneId: chat.paneId },
  );
  await shell.app!.evaluate(() => (globalThis as any).releaseAdmission());
  const conflict = shell
    .pane(chat.paneId)
    .getByRole("region", { name: "Draft conflict" });
  await expect(conflict).toBeVisible();
  await expect(input).toHaveValue("Local next message");
  await expect
    .poll(async () => {
      const saved = await draft(workspace, chat.paneId);
      return { external: saved?.text, local: saved?.localDraft?.text };
    })
    .toEqual({ external: "Other writer message", local: "Local next message" });
});
