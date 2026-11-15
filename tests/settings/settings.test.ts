import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SettingsService } from "../../src/application/settings-service.ts";
import { validateSettings } from "../../src/settings.ts";
test("settings reject unknown, unsafe and invalid values", () => {
  for (const value of [
    [],
    null,
    { other: 1 },
    { "terminal.cursorStyle": "bad" },
    { "terminal.scrollback": -1 },
    { "ui.fontFamily": "x; color:red" },
    { "editor.tabSize": 2.5 },
  ])
    assert.throws(() => validateSettings(value));
  assert.deepEqual(
    validateSettings({
      "terminal.cursorStyle": "bar",
      "terminal.cursorBlink": true,
    }),
    { "terminal.cursorStyle": "bar", "terminal.cursorBlink": true },
  );
});
test("settings preserve last good values, reject overwrite of broken JSON, serialize updates and reset", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-settings-"));
  try {
    const settings = new SettingsService(directory);
    await settings.load();
    await Promise.all([
      settings.update({ "ui.fontSize": 20 }),
      settings.update({ "terminal.cursorStyle": "bar" }),
    ]);
    assert.equal(settings.state.values["ui.fontSize"], 20);
    assert.equal(settings.state.values["terminal.cursorStyle"], "bar");
    await writeFile(settings.state.path, "invalid");
    await settings.load();
    assert.ok(settings.state.error);
    assert.equal(settings.state.values["ui.fontSize"], 20);
    await assert.rejects(settings.update({ "ui.fontSize": 14 }));
    assert.equal(await readFile(settings.state.path, "utf8"), "invalid");
    await writeFile(
      settings.state.path,
      '{"terminal.cursorStyle":"underline"}',
    );
    await settings.load();
    assert.equal(settings.state.error, undefined);
    assert.equal(settings.state.values["terminal.cursorStyle"], "underline");
    await settings.update({}, true);
    assert.equal(settings.state.values["ui.fontSize"], 14);
    assert.deepEqual(
      JSON.parse(await readFile(settings.state.path, "utf8")),
      {},
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
