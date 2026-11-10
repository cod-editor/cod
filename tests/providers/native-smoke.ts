/** Explicit opt-in, no inference: starts native controllers and creates empty sessions. */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodexAdapter,
  createKimiAdapter,
} from "../../src/providers/index.ts";
if (process.env.COD_RUN_NATIVE_SMOKE !== "1")
  throw new Error(
    "Set COD_RUN_NATIVE_SMOKE=1 to start installed native providers",
  );
const cwd = await realpath(await mkdtemp(join(tmpdir(), "cod-adapter-smoke-")));
try {
  for (const create of [createCodexAdapter, createKimiAdapter]) {
    const adapter = create({ cwd, requestTimeoutMs: 15_000 });
    try {
      const conversation = await adapter.create();
      if (!conversation.nativeId)
        throw new Error("Native conversation identity missing");
      console.log(
        `${conversation.provider}: native initialization and create PASS (no inference)`,
      );
    } finally {
      await adapter.dispose();
    }
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
