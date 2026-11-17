import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rankCommands,
  validCommandHistory,
  commandMatchCost,
} from "../../src/ui/command-search.ts";
const commands = [
  { id: "new", title: "New workspace", aliases: ["create task"] },
  { id: "rename", title: "Rename workspace", aliases: ["change task name"] },
  { id: "close", title: "Close workspace", aliases: ["archive task"] },
  { id: "settings", title: "Settings...", aliases: ["appearance", "fonts"] },
];
test("tokens match in either order and title matches outrank loose subsequences", () => {
  assert.deepEqual(
    rankCommands(commands, "work ren", []).map((row) => row.id),
    ["rename"],
  );
  assert.equal(
    rankCommands(commands, "rename workspace", ["close"])[0].id,
    "rename",
  );
  assert.ok(
    commandMatchCost(commands[0], "new")! <
      commandMatchCost(commands[1], "new")!,
  );
});
test("aliases and partial spellings find everyday commands without substring-only filtering", () => {
  assert.equal(rankCommands(commands, "appearance", [])[0].id, "settings");
  assert.equal(rankCommands(commands, "rnm wrk", [])[0].id, "rename");
  assert.equal(rankCommands(commands, "change name", [])[0].id, "rename");
  assert.deepEqual(rankCommands(commands, "unrelated", []), []);
});
test("empty search puts recent commands first exactly once, with stable remaining order", () => {
  assert.deepEqual(
    rankCommands(commands, "", ["settings", "close"]).map((row) => row.id),
    ["settings", "close", "new", "rename"],
  );
  assert.deepEqual(
    rankCommands(commands, "  ", []).map((row) => row.id),
    commands.map((row) => row.id),
  );
});
test("saved history ignores malformed, duplicate and removed command IDs and stays bounded", () => {
  assert.deepEqual(validCommandHistory(null, commands), []);
  assert.deepEqual(
    validCommandHistory(["removed", 1, "close", "close", "new"], commands),
    ["close", "new"],
  );
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    title: String(i),
    aliases: [],
  }));
  assert.equal(
    validCommandHistory(
      many.map((row) => row.id),
      many,
    ).length,
    20,
  );
});
