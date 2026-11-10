// Exercise the same forced-disconnect boundary that previously left empty JSON.
// No app operations or native account: real subprocesses speak fixture ACP.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
const temporary = await mkdtemp(path.join(os.tmpdir(), "cod-history-atomic-"));
try {
  const bundle = path.join(temporary, "providers.mjs");
  await build({
    entryPoints: ["src/providers/index.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { createKimiAdapter } = await import(pathToFileURL(bundle));
  for (let iteration = 0; iteration < 20; iteration++) {
    const recording = path.join(temporary, `fixture-${iteration}.jsonl`);
    const adapter = createKimiAdapter({
      cwd: temporary,
      executable: process.execPath,
      args: [
        path.resolve("tests/review-integration/provider-wrapper.mjs"),
        "kimi",
        recording,
      ],
      requestTimeoutMs: 5000,
      turnTimeoutMs: 5000,
      onEvent: () => {},
    });
    let nativeId;
    try {
      nativeId = (await adapter.create()).nativeId;
      await assert.rejects(() =>
        adapter.send(
          "[review-accepted-disconnect] invented " + "x".repeat(128 * 1024),
        ),
      );
    } finally {
      await adapter.dispose();
    }
    const history = JSON.parse(
      await readFile(
        path.join(recording + ".sessions", nativeId + ".json"),
        "utf8",
      ),
    );
    assert(Array.isArray(history));
    assert(JSON.stringify(history).includes("[review-accepted-disconnect]"));
  }
  console.log(
    "PASS 20 forced Kimi fixture disconnects retain parseable accepted native history",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
