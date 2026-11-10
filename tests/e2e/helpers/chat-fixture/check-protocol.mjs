// Fixture protocol self-check only. This is not application or live-provider evidence.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCodexAdapter,
  createKimiAdapter,
} from "../../../../src/providers/index.ts";

const fixture = await mkdtemp(path.join(os.tmpdir(), "cod-chat-protocol-"));
const executable = fileURLToPath(new URL("./provider.mjs", import.meta.url));
try {
  for (const [provider, create] of [
    ["codex", createCodexAdapter],
    ["kimi", createKimiAdapter],
  ]) {
    const events = [];
    const options = {
      cwd: fixture,
      executable: process.execPath,
      args: [executable, provider, path.join(fixture, `${provider}.jsonl`)],
      onEvent: (event) => events.push(event),
      requestTimeoutMs: 3000,
      turnTimeoutMs: 5000,
    };
    const adapter = create(options);
    let id;
    try {
      id = (await adapter.create()).nativeId;
      assert.equal((await adapter.send("ordinary")).status, "completed");
      assert(
        events.some(
          (event) =>
            event.type === "text" && event.text.includes("DONE ordinary"),
        ),
      );
      assert(
        !events.some(
          (event) =>
            event.type === "text" && event.text.includes("FOREIGN_OUTPUT"),
        ),
      );
      const approval = adapter.send("[approve] approval");
      let permission;
      for (let attempt = 0; attempt < 50; attempt++) {
        permission = events.find((event) => event.type === "permission");
        if (permission) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert(permission);
      await adapter.permission(
        permission.requestId,
        permission.options.find((option) => option.label === "Allow once").id,
      );
      assert.equal((await approval).status, "completed");
      const held = adapter.send("[hold] cancellation");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await adapter.cancel();
      assert.equal((await held).status, "cancelled");
      await assert.rejects(adapter.send("[crash] failure"), /exited/);
    } finally {
      await adapter.dispose();
    }
    events.length = 0;
    const resumed = create(options);
    try {
      assert.equal((await resumed.resume(id)).nativeId, id);
      if (provider === "codex")
        assert(
          events.some(
            (event) =>
              event.type === "history" &&
              event.details.turns?.some((turn) =>
                turn.items.some(
                  (item) =>
                    item.type === "userMessage" &&
                    item.content[0].text === "ordinary",
                ),
              ),
          ),
        );
      else {
        assert(
          events.some(
            (event) =>
              event.type === "text" &&
              event.replay &&
              event.role === "user" &&
              event.text === "ordinary",
          ),
        );
        assert(events.some((event) => event.type === "tool" && event.replay));
      }
      assert.equal((await resumed.send("resumed")).status, "completed");
    } finally {
      await resumed.dispose();
    }
    console.log(
      `PASS ${provider} fixture protocol against native adapter: stream, foreign filtering, permission, cancel, crash, resume with persisted native history`,
    );
  }
} finally {
  await rm(fixture, { recursive: true, force: true });
}
