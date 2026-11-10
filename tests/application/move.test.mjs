import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
let temporary, Store, Workspaces, Reviews, Files;
before(async () => {
  temporary = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "cod-transfer-")),
  );
  const outfile = path.join(temporary, "services.cjs");
  await build({
    stdin: {
      contents:
        'export {ApplicationStateStore as Store} from "./src/application/state"; export {WorkspaceApplicationService as Workspaces} from "./src/application/workspace-service"; export {ReviewService as Reviews} from "./src/reviews/index"; export {FileApplicationService as Files} from "./src/application/file-service";',
      resolveDir: process.cwd(),
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  ({ Store, Workspaces, Reviews, Files } = createRequire(import.meta.url)(
    outfile,
  ));
});
after(async () => {
  await rm(temporary, { recursive: true, force: true });
});
async function setup(name) {
  const root = path.join(temporary, name);
  await mkdir(root);
  const store = new Store(path.join(root, "state"));
  await store.load();
  const reviews = new Reviews({
    dataDirectory: store.directory,
    workspaceFolders: async (id) => store.workspace(id).folders,
    conversationWorkspace: async (id) =>
      store.data.conversations.find((c) => c.id === id)?.workspaceId,
  });
  const workspace = new Workspaces(
    store,
    {
      disposeController: () => {
        throw new Error("A move must not stop a controller");
      },
    },
    {},
    {},
    {
      list: () => reviews.list(),
      relocateOrigin: async (id, destination) => {
        await reviews.relocateOrigin(id, destination);
        store.data.reviews = await reviews.list();
      },
      reconcileOrigins: () => reviews.reconcileOrigins(),
    },
  );
  const source = workspace.createWorkspace("source").id;
  store.workspace(source).folders = [root];
  const destination = workspace.createWorkspace("destination").id;
  const paneId = store.workspace(source).panes[0].id;
  const conversation = {
    id: "conversation",
    paneId,
    workspaceId: source,
    provider: "codex",
    nativeId: "same-native-session",
    cwd: root,
    status: "working",
    messages: [{ id: "m", role: "assistant", text: "ongoing", order: 1 }],
    tools: [],
    pendingPermissions: [{ id: "permission", options: [], details: {} }],
  };
  store.data.conversations.push(conversation);
  store.workspace(source).panes = [
    { id: paneId, kind: "conversation", conversationId: conversation.id },
  ];
  store.workspace(source).chatDrafts = {
    [paneId]: {
      text: "draft",
      images: [{ mimeType: "image/png", data: "fixture" }],
    },
  };
  return {
    root,
    store,
    reviews,
    workspace,
    source,
    destination,
    conversation,
    paneId,
  };
}
test("move keeps the live session, draft, permission and origin review; restart retains membership", async () => {
  const f = await setup("preserve");
  const file = path.join(f.root, "spec.md");
  await writeFile(file, "review me\n");
  const review = await f.reviews.openDocument({
    workspaceId: f.source,
    path: file,
    originConversationId: f.conversation.id,
  });
  await f.reviews.addComment({
    id: review.id,
    roundId: review.currentRoundId,
    expectedVersion: review.version,
    body: "Preserve this private draft",
    range: { startLine: 1, endLine: 1 },
  });
  f.store
    .workspace(f.source)
    .panes.push({ id: "review-pane", kind: "review", reviewId: review.id });
  f.store.data.activeWorkspaceId = f.source;
  f.store.workspace(f.source).activePaneId = f.paneId;
  const result = await f.workspace.handle({
    op: "conversation.move",
    id: f.conversation.id,
    workspace: f.destination,
  });
  assert.equal(result.nativeId, "same-native-session");
  assert.equal(result.cwd, f.root);
  assert.equal(f.store.data.conversations[0], f.conversation);
  assert.equal(f.conversation.status, "working");
  assert.equal(f.conversation.pendingPermissions[0].id, "permission");
  assert.equal(f.store.data.activeWorkspaceId, f.destination);
  assert.equal(
    f.store
      .workspace(f.destination)
      .panes.filter((p) => p.kind === "conversation").length,
    1,
  );
  assert.equal(
    f.store
      .workspace(f.destination)
      .panes.some((p) => p.kind === "document" && p.draftChat),
    false,
  );
  assert.equal(
    f.store.workspace(f.destination).chatDrafts[f.paneId].images[0].data,
    "fixture",
  );
  assert.equal((await f.reviews.inspect(review.id)).workspaceId, f.destination);
  assert.equal(
    (await f.reviews.detail(review.id)).rounds[0].comments[0].body,
    "Preserve this private draft",
  );
  assert.equal((await f.reviews.changed(review.id)).unavailable, false);
  const moved = await f.reviews.inspect(review.id);
  await f.reviews.refresh({
    id: review.id,
    expectedRoundId: moved.currentRoundId,
    expectedVersion: moved.version,
  });
  const restored = new Store(f.store.directory);
  await restored.load();
  assert.equal(restored.data.conversations[0].workspaceId, f.destination);
});
test("background transfer does not steal another workspace and preserves destination drafts", async () => {
  const f = await setup("background");
  const other = f.workspace.createWorkspace("unrelated").id;
  const draftPane = f.store.workspace(f.destination).panes[0].id;
  f.store.workspace(f.destination).chatDrafts = {
    [draftPane]: { text: "do not discard" },
  };
  await f.workspace.handle({
    op: "conversation.move",
    id: f.conversation.id,
    workspace: f.destination,
  });
  assert.equal(f.store.data.activeWorkspaceId, other);
  assert.equal(
    f.store.workspace(f.destination).chatDrafts[draftPane].text,
    "do not discard",
  );
  await f.workspace.handle({
    op: "conversation.move",
    id: f.conversation.id,
    workspace: f.source,
    follow: true,
  });
  assert.equal(f.store.data.activeWorkspaceId, f.source);
});
test("failed application persistence rolls review membership and live conversation identity back", async () => {
  const f = await setup("rollback");
  const file = path.join(f.root, "spec.md");
  await writeFile(file, "review me\n");
  const review = await f.reviews.openDocument({
    workspaceId: f.source,
    path: file,
    originConversationId: f.conversation.id,
  });
  const persist = f.store.persist.bind(f.store);
  f.store.persist = async () => {
    throw new Error("fixture disk failure");
  };
  await assert.rejects(
    f.workspace.handle({
      op: "conversation.move",
      id: f.conversation.id,
      workspace: f.destination,
    }),
    /disk failure/,
  );
  assert.equal(f.store.data.conversations[0], f.conversation);
  assert.equal(f.conversation.workspaceId, f.source);
  assert.equal((await f.reviews.inspect(review.id)).workspaceId, f.source);
  f.store.persist = persist;
});

test("ensure left reveals an empty material pane once and real files replace the placeholder", async () => {
  const f = await setup("empty-material");
  const first = await f.workspace.handle({
    op: "group.ensure",
    workspace: f.source,
    side: "left",
  });
  assert.equal(
    f.store.workspace(f.source).panes.find((p) => p.id === first.paneId).kind,
    "empty",
  );
  const repeated = await f.workspace.handle({
    op: "group.ensure",
    workspace: f.source,
    side: "left",
  });
  assert.equal(repeated.groupId, first.groupId);
  assert.equal(f.store.data.conversations.length, 1);
  const file = path.join(f.root, "readme.md");
  await writeFile(file, "real material");
  const opened = await new Files(f.store).handle({
    op: "file.open",
    workspace: f.source,
    path: file,
  });
  assert.equal(
    f.store.workspace(f.source).groups.find((g) => g.id === first.groupId)
      .paneIds[0],
    opened.paneId,
  );
  assert.equal(
    f.store.workspace(f.source).panes.some((p) => p.kind === "empty"),
    false,
  );
  const right = await f.workspace.handle({
    op: "group.ensure",
    workspace: f.source,
    side: "right",
  });
  assert.equal(right.paneId, f.paneId);
  await f.workspace.handle({
    op: "group.visibility",
    workspace: f.source,
    id: first.groupId,
    hidden: true,
  });
  await assert.rejects(
    f.workspace.handle({
      op: "group.visibility",
      workspace: f.source,
      id: right.groupId,
      hidden: true,
    }),
    /remain visible/,
  );
  await f.workspace.handle({
    op: "group.ensure",
    workspace: f.source,
    side: "left",
  });
  assert.equal(
    f.store.workspace(f.source).groups.find((g) => g.id === first.groupId)
      .hidden,
    false,
  );
});

test("global new chat starts from no workspaces and preserves closed tasks", async () => {
  const store = new Store(path.join(temporary, "new-chat"));
  await store.load();
  const service = new Workspaces(store, {}, {}, {}, { list: async () => [] });
  const first = await service.handle({ op: "conversation.draft" });
  assert.equal(store.data.workspaces.length, 1);
  assert.equal(store.data.workspaces[0].name, "Untitled");
  assert.equal(store.data.activeWorkspaceId, first.workspaceId);
  assert.equal(store.data.workspaces[0].panes.length, 1);
  assert.equal(store.data.conversations.length, 0);
  assert.deepEqual(await service.handle({ op: "conversation.draft" }), first);
  store.data.workspaces[0].chatDrafts = {
    [first.paneId]: { text: "Keep this unfinished task" },
  };
  await service.handle({ op: "workspace.close", id: first.workspaceId });
  assert.equal(store.data.workspaces.length, 0);
  const archive = structuredClone(store.data.closedWorkspaces);
  const second = await service.handle({ op: "conversation.draft" });
  assert.notEqual(second.workspaceId, first.workspaceId);
  assert.deepEqual(store.data.closedWorkspaces, archive);
  assert.equal(store.data.conversations.length, 0);
  const explicit = await service.handle({
    op: "conversation.draft",
    workspace: second.workspaceId,
  });
  assert.notEqual(explicit.paneId, second.paneId);
  assert.equal(store.data.workspaces.length, 1);
  const restored = new Store(store.directory);
  await restored.load();
  assert.deepEqual(restored.data.closedWorkspaces, archive);
  assert.equal(restored.data.activeWorkspaceId, second.workspaceId);
});
