// Zero inference. Explicit manual command only; never a CI test.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createCodexAdapter,
  createKimiAdapter,
} from "../../src/providers/index.ts";
const cwd = await mkdtemp(path.join(tmpdir(), "cod-native-options-"));
try {
  for (const provider of ["codex", "kimi"] as const) {
    const adapter = (
      provider === "codex" ? createCodexAdapter : createKimiAdapter
    )({ cwd, requestTimeoutMs: 20000 });
    try {
      await adapter.create();
      const before = await adapter.getOptions();
      if (!before.current.model)
        throw new Error("Native current model unavailable");
      const selected = await adapter.setOption({
        option: "model",
        value: before.current.model,
      });
      if (
        (provider === "codex"
          ? selected.pending?.model
          : selected.current.model) !== before.current.model
      )
        throw new Error("Selection not acknowledged");
      console.log(
        JSON.stringify({
          provider,
          result: "PASS",
          models: before.models.length,
          reasoningChoices: before.reasoning.length,
          effect: selected.selectionEffect,
        }),
      );
    } catch {
      console.log(
        JSON.stringify({
          provider,
          result: "FAIL",
          error: "Native option check failed; diagnostics withheld",
        }),
      );
      process.exitCode = 1;
    } finally {
      await adapter.dispose();
    }
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
