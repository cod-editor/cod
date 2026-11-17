import { test } from "node:test";
import assert from "node:assert/strict";
import { NativeSelection } from "../../src/providers/selection.ts";

test("effective selection copies validated overrides without an old model's reasoning", async () => {
  const selection = new NativeSelection("codex");
  selection.bind({ model: "first", reasoningEffort: "high" });
  assert.deepEqual(selection.snapshot(), { model: "first", reasoning: "high" });
  let calls = 0;
  const request = async (method: string) => {
    assert.equal(method, "model/list");
    calls++;
    return {
      data: [
        {
          model: "first",
          displayName: "First",
          supportedReasoningEfforts: [
            { reasoningEffort: "high", description: "High" },
          ],
        },
        {
          model: "second",
          displayName: "Second",
          supportedReasoningEfforts: [],
        },
      ],
    };
  };
  await selection.set({ option: "model", value: "second" }, "native", request);
  assert.deepEqual(selection.snapshot(), { model: "second" });
  assert.equal(
    calls,
    2,
    "Reading current selection must not start native metadata work",
  );
  await assert.rejects(() =>
    selection.set({ option: "reasoning", value: "high" }, "native", request),
  );
  assert.deepEqual(selection.snapshot(), { model: "second" });
});
