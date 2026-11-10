import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const temporary = await mkdtemp(path.join(os.tmpdir(), "cod-review-protocol-"));
try {
  const bundle = path.join(temporary, "providers.mjs");
  await build({
    entryPoints: ["src/providers/index.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const adapters = await import(pathToFileURL(bundle));
  for (const provider of ["codex", "kimi"]) {
    const recording = path.join(temporary, provider + ".jsonl");
    await writeFile(recording, "");
    const create =
      provider === "codex"
        ? adapters.createCodexAdapter
        : adapters.createKimiAdapter;
    const events = [];
    const options = {
      cwd: temporary,
      executable: process.execPath,
      args: [
        path.resolve("tests/review-integration/provider-wrapper.mjs"),
        provider,
        recording,
      ],
      requestTimeoutMs: 5000,
      turnTimeoutMs: 5000,
      onEvent: (event) => events.push(event),
    };
    let adapter = create(options);
    let nativeId;
    try {
      nativeId = (await adapter.create()).nativeId;
      assert.equal(
        (await adapter.send("ordinary invented turn")).status,
        "completed",
      );
      await assert.rejects(() =>
        adapter.send("[review-accepted-disconnect] invented envelope"),
      );
    } finally {
      await adapter.dispose();
    }
    events.length = 0;
    adapter = create(options);
    try {
      await adapter.resume(nativeId);
      const history = events.filter(
        (event) => event.type === "history" || event.replay,
      );
      assert(JSON.stringify(history).includes("[review-accepted-disconnect]"));
    } finally {
      await adapter.dispose();
    }
    const records = (await readFile(recording, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      records.filter(
        (record) =>
          ["turn/start", "session/prompt"].includes(record.message?.method) &&
          JSON.stringify(record.message.params).includes(
            "[review-accepted-disconnect]",
          ),
      ).length,
      1,
    );
    console.log(
      `${provider}: normal turn, accepted disconnect and native history replay PASS`,
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
