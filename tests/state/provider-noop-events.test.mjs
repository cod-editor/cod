import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  openWorkspaceState,
  readWorkspaceState,
} from "../support/workspace-state.ts";

// Bundle the same application classes as Electron: their UI-side imports use
// extensionless module paths that the native TypeScript runner cannot resolve.
const { outputFiles } = await build({
  stdin: {
    contents:
      'export { ConversationApplicationService } from "./src/application/conversation-service.ts"; export { ApplicationStateStore } from "./src/application/state.ts";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  define: {
    "import.meta.dirname": JSON.stringify(path.resolve("src/application")),
  },
  write: false,
});
const moduleDirectory = await mkdtemp(
  path.join(os.tmpdir(), "cod-provider-module-"),
);
const moduleFile = path.join(moduleDirectory, "service.mjs");
await writeFile(moduleFile, outputFiles[0].text);
after(() => rm(moduleDirectory, { recursive: true, force: true }));
const { ConversationApplicationService, ApplicationStateStore } = await import(
  pathToFileURL(moduleFile).href
);

async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cod-provider-events-"),
  );
  const store = new ApplicationStateStore(directory);
  await store.load();
  store.data.conversations.push({
    id: "conversation",
    workspaceId: "workspace",
    paneId: "pane",
    provider: "codex",
    nativeId: "fixture",
    status: "ready",
    messages: [],
    tools: [],
    pendingPermissions: [],
  });
  await store.persist();
  let snapshots = 0;
  let persists = 0;
  store.onDidChange = () => snapshots++;
  const persist = store.persist.bind(store);
  store.persist = async (...args) => {
    persists++;
    await persist(...args);
  };
  const service = new ConversationApplicationService(store, {}, {});
  const event = (body) =>
    service.providerEvent("conversation", {
      provider: "codex",
      nativeId: "fixture",
      ...body,
    });
  return {
    store,
    event,
    counters: () => ({ snapshots, persists }),
    async close() {
      store.beginShutdown();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Stream deltas checkpoint on a fixed deadline and completion absorbs pending work", async (t) => {
  const app = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const emit = (text) =>
      app.event({
        type: "text",
        text,
        role: "assistant",
        replay: false,
        itemId: "synthetic reply",
      });
    emit("one");
    t.mock.timers.tick(250);
    emit(" two");
    t.mock.timers.tick(1_749);
    emit(" three");
    await app.store.serialize(() => undefined);
    assert.ok(app.counters().snapshots > 0);
    assert.equal(app.counters().persists, 0);

    t.mock.timers.tick(1);
    await app.store.serialize(() => undefined);
    assert.equal(app.counters().persists, 1);
    const restart = () =>
      readWorkspaceState(app.store.directory).conversations[0];
    assert.equal(restart().messages[0].text, "one two three");

    emit(" four");
    app.event({ type: "completed", outcome: { status: "completed" } });
    t.mock.timers.tick(1);
    await app.store.serialize(() => undefined);
    assert.equal(app.counters().persists, 2);
    assert.equal(restart().messages[0].text, "one two three four");
    t.mock.timers.tick(2_000);
    await app.store.serialize(() => undefined);
    assert.equal(app.counters().persists, 2);
  } finally {
    await app.close();
  }
});

test("A delta arriving while a full snapshot is writing reaches the next checkpoint", async (t) => {
  const app = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const emit = (text) =>
      app.event({
        type: "text",
        text,
        role: "assistant",
        replay: false,
        itemId: "synthetic reply",
      });
    emit("first");
    const persist = app.store.persist.bind(app.store);
    app.store.persist = () => {
      app.store.persist = persist;
      const pending = persist();
      emit(" next");
      return pending;
    };
    await app.store.change(() => {}, { notify: false });
    assert.equal(
      readWorkspaceState(app.store.directory).conversations[0].messages[0].text,
      "first",
    );

    t.mock.timers.tick(2_000);
    await app.store.serialize(() => undefined);
    assert.equal(
      readWorkspaceState(app.store.directory).conversations[0].messages[0].text,
      "first next",
    );
    assert.equal(app.counters().persists, 2);
  } finally {
    await app.close();
  }
});

test("A failed durable checkpoint leaves passive progress eligible for another save", async (t) => {
  const app = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await app.store.persist();
    using db = openWorkspaceState(app.store.directory);
    db.exec(`
      CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON records
      WHEN NEW.kind = 'conversation'
      BEGIN SELECT RAISE(ABORT, 'Invented checkpoint failure'); END;
    `);
    app.event({
      type: "text",
      text: "Invented checkpoint retry",
      role: "assistant",
      replay: false,
    });
    await assert.rejects(
      app.store.change(() => {}, { notify: false }),
      /Invented checkpoint failure/,
    );
    assert.deepEqual(
      readWorkspaceState(app.store.directory).conversations[0].messages,
      [],
    );
    db.exec("DROP TRIGGER fail_checkpoint");

    t.mock.timers.tick(2_000);
    await app.store.serialize(() => undefined);
    assert.equal(
      readWorkspaceState(app.store.directory).conversations[0].messages[0].text,
      "Invented checkpoint retry",
    );
  } finally {
    await app.close();
  }
});

test("Informational provider diagnostics and ignored history do not rewrite or broadcast state", async () => {
  const app = await fixture();
  try {
    for (let index = 0; index < 8; index++) {
      app.event({
        type: "diagnostic",
        message: "Invented provider diagnostic",
      });
      app.event({
        type: "history",
        details: { thread: { id: "fixture", turns: [] } },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.deepEqual(app.counters(), { snapshots: 0, persists: 0 });
    assert.equal(app.store.data.conversations[0].status, "ready");
  } finally {
    await app.close();
  }
});

test("Actual provider state and reply changes still notify and persist", async () => {
  const app = await fixture();
  try {
    app.event({ type: "state", state: "working" });
    app.event({
      type: "text",
      text: "Invented visible reply",
      role: "assistant",
      replay: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(app.store.data.conversations[0].status, "working");
    assert.ok(app.counters().snapshots > 0);
    assert.ok(app.counters().persists > 0);
    assert.ok(
      app.store.data.conversations[0].messages.some((message) =>
        message.text.includes("Invented visible reply"),
      ),
    );
  } finally {
    await app.close();
  }
});

test("UI snapshots retain labels and attention without copying hidden history or images", async () => {
  const app = await fixture();
  try {
    const makeWorkspace = (id, conversation) => ({
      id,
      name: "Invented workspace",
      folders: [],
      panes: [
        {
          id: conversation.paneId,
          kind: "conversation",
          conversationId: conversation.id,
        },
      ],
      activePaneId: conversation.paneId,
      groups: [
        {
          id: "group",
          paneIds: [conversation.paneId],
          activePaneId: conversation.paneId,
        },
      ],
      groupLayout: { type: "leaf", paneId: "group" },
      activeGroupId: "group",
    });
    const visible = app.store.data.conversations[0];
    const hidden = {
      ...visible,
      id: "hidden",
      paneId: "hidden-pane",
      workspaceId: "background",
      messages: [
        {
          id: "question",
          role: "user",
          order: 0,
          text: "Invented question",
          images: [
            {
              mimeType: "image/png",
              name: "Invented image",
              data: "x".repeat(1024 * 1024),
            },
          ],
        },
        {
          id: "answer",
          role: "assistant",
          order: 1,
          text: "Invented history ".repeat(64000),
        },
      ],
      tools: [
        {
          id: "tool",
          order: 2,
          details: { output: "Invented output ".repeat(64000) },
        },
      ],
      pendingPermissions: [
        { id: "approval", description: "Invented approval" },
      ],
      completionRevision: 3,
    };
    app.store.data.conversations.push(hidden);
    app.store.data.workspaces.push(
      makeWorkspace("workspace", visible),
      makeWorkspace("background", hidden),
    );
    app.store.data.activeWorkspaceId = "workspace";
    const projected = app.store.snapshot(true);
    assert.ok(JSON.stringify(projected).length < 10000);
    assert.equal(
      projected.conversations[1].messages[0].text,
      "Invented question",
    );
    assert.equal(
      projected.conversations[1].messages[0].images[0].name,
      "Invented image",
    );
    assert.deepEqual(
      projected.conversations[1].pendingPermissions,
      hidden.pendingPermissions,
    );
    assert.equal(projected.conversations[1].completionRevision, 3);
    assert.equal(app.store.snapshot().conversations[1].messages.length, 2);
    assert.equal(hidden.messages[0].images[0].data.length, 1024 * 1024);
    app.store.data.activeWorkspaceId = "background";
    assert.deepEqual(app.store.snapshot(true).conversations[1], hidden);
  } finally {
    await app.close();
  }
});

test("Failed navigation persistence rolls back layout while retaining live provider data", async () => {
  const app = await fixture();
  try {
    const conversation = app.store.data.conversations[0];
    app.store.data.workspaces.push({
      id: "workspace",
      name: "Original",
      folders: [],
      panes: [
        { id: "pane", kind: "conversation", conversationId: conversation.id },
      ],
      activePaneId: "pane",
      groups: [{ id: "group", paneIds: ["pane"], activePaneId: "pane" }],
      groupLayout: { type: "leaf", paneId: "group" },
      activeGroupId: "group",
    });
    app.store.data.activeWorkspaceId = "workspace";
    conversation.messages.push({
      id: "first",
      role: "user",
      order: 0,
      text: "Invented question",
    });
    conversation.queuedMessages = [
      { id: "queued", text: "Invented queued message", status: "queued" },
    ];
    app.store.persist = async () => {
      conversation.messages.push({
        id: "reply",
        role: "assistant",
        order: 1,
        text: "Invented live reply",
      });
      conversation.status = "working";
      throw new Error("Invented disk failure");
    };
    await assert.rejects(
      app.store.change(() => {
        app.store.data.workspaces[0].name = "Changed";
        conversation.queuedMessages[0].text = "Changed queued message";
      }),
      /Invented disk failure/,
    );
    assert.equal(app.store.data.workspaces[0].name, "Original");
    assert.equal(app.store.data.conversations[0], conversation);
    assert.equal(conversation.messages[1].text, "Invented live reply");
    assert.equal(conversation.status, "working");
    assert.equal(
      conversation.queuedMessages[0].text,
      "Invented queued message",
    );
  } finally {
    await app.close();
  }
});
