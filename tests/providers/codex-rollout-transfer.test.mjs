import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const nativeId = "00000000-0000-4000-8000-000000000001";
const revisionId = "00000000-0000-4000-8000-000000000002";
const stem = `rollout-2026-01-01T12-00-00-${nativeId}`;
const otherName = stem + "_" + revisionId + ".jsonl";
const activeName = stem + ".jsonl";
const binding = { nativeId, workspace: "workspace", cwd: "/invented" };

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const entry = (filename, bytes) => ({
  filename,
  size: bytes.length,
  digest: digest(bytes),
});
const meta = (history_base) =>
  JSON.stringify({
    type: "session_meta",
    payload: { id: nativeId, history_base },
  }) + "\n";

test("Codex staged transfers verify bounded ordered chunks and own the installed files", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "cod-transfer-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fixture = path.join(home, "test.mjs");
  await build({
    stdin: {
      contents: `export * from "./src/providers/codex-rollout.ts";
                 export * from "./src/providers/codex-rollout-staging.ts";`,
      resolveDir: process.cwd(),
    },
    outfile: fixture,
    platform: "node",
    bundle: true,
    format: "esm",
  });
  const runtime = await import(pathToFileURL(fixture).href);
  const {
    appendCodexChunk,
    beginCodexStage,
    readCodexStage,
    removeCodexStage,
    installCodexRollout,
    codexRolloutChunkBytes: chunk,
    maximumCodexRolloutBytes: maximum,
  } = runtime;
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  });

  const stageRoot = path.join(home, ".cod-transfer-staging");
  const activeHeader = meta();
  const active = Buffer.concat([
    Buffer.from(activeHeader),
    Buffer.alloc(chunk, 0x20),
    Buffer.from("\n"),
  ]);
  const manifest = entry(activeName, active);
  const upload = (id, offset, bytes) =>
    appendCodexChunk(id, binding, offset, bytes.toString("base64"));

  const transfer = randomUUID();
  await assert.rejects(
    beginCodexStage(transfer, binding, { ...manifest, size: maximum + 1 }),
    /256 MiB/,
  );
  await assert.rejects(
    beginCodexStage(transfer, binding, {
      ...manifest,
      filename: "../" + activeName,
    }),
    /native ID/,
  );
  await assert.rejects(
    beginCodexStage(transfer, binding, { ...manifest, filename: otherName }),
    /linked Codex history/,
  );
  await beginCodexStage(transfer, binding, manifest);
  await assert.rejects(
    upload(transfer, chunk, active.subarray(chunk)),
    /out of order/,
  );
  await assert.rejects(
    appendCodexChunk(transfer, binding, 0, "%%%notBase64"),
    /Invalid Codex session chunk/,
  );

  // Simulate a host crash between writing and acknowledging its first chunk.
  await writeFile(
    path.join(stageRoot, transfer, "rollout.part"),
    active.subarray(0, 71),
  );
  await beginCodexStage(transfer, binding, manifest);
  const first = active.subarray(0, chunk);
  await upload(transfer, 0, first);
  await upload(transfer, 0, first);
  const corrupt = Buffer.from(first);
  corrupt[63] ^= 1;
  await assert.rejects(upload(transfer, 0, corrupt), /chunk has changed/);
  await assert.rejects(readCodexStage(transfer, binding), /incomplete/);
  await upload(transfer, chunk, active.subarray(chunk));
  const stage = await readCodexStage(transfer, binding);
  assert.deepEqual(stage.manifest, manifest);

  const linkedFile = path.join(home, "linked.jsonl");
  const linked = Buffer.from(
    meta({
      thread_id: nativeId,
      end_byte_offset: active.length,
      end_ordinal_exclusive: 3,
    }),
  );
  await writeFile(linkedFile, linked);
  await assert.rejects(
    installCodexRollout(
      nativeId,
      entry(activeName, linked),
      linkedFile,
      transfer,
    ),
    /linked Codex history/,
  );

  const previous = path.join(home, "sessions", "2026", "01", "01", otherName);
  await mkdir(path.dirname(previous), { recursive: true });
  await writeFile(previous, active);
  await assert.rejects(
    installCodexRollout(nativeId, manifest, stage.file, transfer),
    /already has saved history/,
  );
  assert.deepEqual(await readFile(previous), active);
  await rm(previous);

  const scratch = path.join(
    path.dirname(previous),
    `.transfer-${transfer}.writing`,
  );
  await writeFile(scratch, "Invented incomplete copy left by host crash");
  const installed = await installCodexRollout(
    nativeId,
    manifest,
    stage.file,
    transfer,
  );
  assert.deepEqual(await readFile(installed.file), active);
  await assert.rejects(stat(scratch), { code: "ENOENT" });
  const restarted = await installCodexRollout(
    nativeId,
    manifest,
    stage.file,
    transfer,
  );
  assert.equal(restarted.file, installed.file);
  await restarted.finish(true);
  await assert.rejects(stat(installed.file), { code: "ENOENT" });
  await removeCodexStage(transfer, binding);
  await assert.rejects(stat(path.join(stageRoot, transfer)), {
    code: "ENOENT",
  });

  const journals = Array.from({ length: 4 }, () => randomUUID());
  await Promise.all(
    journals.map((id) => beginCodexStage(id, binding, manifest)),
  );
  const others = await Promise.allSettled(
    [randomUUID(), randomUUID()].map((id) =>
      beginCodexStage(id, binding, manifest),
    ),
  );
  assert(others.every((result) => result.status === "rejected"));
  const expired = new Date(Date.now() - 16 * 60 * 1000);
  await utimes(path.join(stageRoot, journals[0]), expired, expired);
  await utimes(path.join(stageRoot, journals[1]), expired, expired);
  const newTransfer = randomUUID();
  await beginCodexStage(newTransfer, binding, manifest, new Set([journals[1]]));
  const staged = await readdir(stageRoot);
  assert.equal(staged.length, 4);
  assert(!staged.includes(journals[0]) && staged.includes(journals[1]));
});
