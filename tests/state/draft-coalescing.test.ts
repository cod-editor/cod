import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApplicationStateStore } from "../../src/application/state.ts";
import type { WorkspaceState } from "../../src/types";
import {
  openWorkspaceState,
  readWorkspaceState,
} from "../support/workspace-state.ts";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cod-drafts-"));
  const store = new ApplicationStateStore(root);
  await store.load();
  store.data.workspaces.push({
    id: "w",
    name: "Fixture",
    folders: [],
    panes: [{ id: "p", kind: "document", draftChat: true }],
    activePaneId: "p",
    groups: [{ id: "group", paneIds: ["p"], activePaneId: "p" }],
    groupLayout: { type: "leaf", paneId: "group" },
    activeGroupId: "group",
    chatDrafts: {
      p: {
        text: "original",
        images: [{ mimeType: "image/png", data: "fixture" }],
      },
    },
  } as unknown as WorkspaceState);
  store.data.closedWorkspaces = [
    {
      workspace: {
        ...store.data.workspaces[0]!,
        id: "archived",
        chatDrafts: undefined,
      },
      conversations: [
        {
          id: "old",
          workspaceId: "archived",
          paneId: "p",
          provider: "codex",
          nativeId: "old-session",
          cwd: root,
          status: "ready",
          messages: [
            {
              id: "old-message",
              role: "user",
              text: "fixture-history ".repeat(1_600_000),
              order: 0,
            },
          ],
          tools: [],
          pendingPermissions: [],
        },
      ],
      terminals: [],
      browsers: [],
    },
  ];
  await store.persist();
  return {
    root,
    store,
    edit: (text: string) =>
      store.changeDraft("composer", () => {
        const workspace = store.data.workspaces[0];
        workspace.chatDrafts!.p = { ...workspace.chatDrafts!.p, text };
        return text;
      }),
  };
}
test("rapid edits never rewrite or clone large history, remain durable and preserve ordering", async () => {
  const { root, store, edit } = await fixture();
  try {
    using db = openWorkspaceState(root);
    db.exec(`
      CREATE TRIGGER draft_text_only BEFORE UPDATE ON records
      WHEN NEW.kind <> 'draft-chat'
      BEGIN SELECT RAISE(ABORT, 'Unexpected write outside the draft text'); END;
    `);
    assert.equal(store.data.closedWorkspaces![0]!.conversations.length, 0);
    let snapshots = 0;
    const snapshot = store.snapshot.bind(store);
    store.snapshot = () => {
      snapshots++;
      return snapshot();
    };
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => edit(`draft-${i}`)),
    );
    assert.equal(snapshots, 0);
    const text = String(
      db.prepare("SELECT body FROM records WHERE kind = 'draft-chat'").get()!
        .body,
    );
    assert.ok(text.length < 1000);
    assert.ok(!text.includes("images"));
    const draft = readWorkspaceState(root).workspaces[0]!.chatDrafts!.p!;
    assert.equal(draft.text, "draft-99");
    assert.equal(draft.images![0]!.data, "fixture");
    db.exec("DROP TRIGGER draft_text_only");
    const first = edit("before-send");
    const barrier = store.change(() => {
      store.data.workspaces[0].chatDrafts!.p = { text: "sent-and-cleared" };
    });
    const last = edit("after-send");
    await Promise.all([first, barrier, last]);
    assert.equal(
      readWorkspaceState(root).workspaces[0]!.chatDrafts!.p!.text,
      "after-send",
    );
    await store.change(() => {
      store.data.workspaces[0].chatDrafts!.p = { text: "" };
    });
    assert.equal(
      readWorkspaceState(root).workspaces[0]!.chatDrafts!.p!.text,
      "",
    );
    using reader = openWorkspaceState(root, true);
    assert.equal(
      reader.prepare("SELECT id FROM records WHERE kind = 'draft-images'").all()
        .length,
      0,
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("draft write failure rejects all pending callers and retains the original draft", async () => {
  const { root, store, edit } = await fixture();
  try {
    using db = openWorkspaceState(root);
    db.exec(`
      CREATE TRIGGER fail_draft BEFORE UPDATE ON records
      WHEN NEW.kind = 'draft-chat'
      BEGIN SELECT RAISE(ABORT, 'Invented draft failure'); END;
    `);
    const results = await Promise.allSettled([edit("first"), edit("latest")]);
    assert.ok(results.every((result) => result.status === "rejected"));
    assert.equal(store.data.workspaces[0].chatDrafts!.p.text, "original");
    assert.equal(
      readWorkspaceState(root).workspaces[0]!.chatDrafts!.p!.text,
      "original",
    );
    db.exec("DROP TRIGGER fail_draft");
    await edit("retry");
    assert.equal(
      readWorkspaceState(root).workspaces[0]!.chatDrafts!.p!.text,
      "retry",
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
