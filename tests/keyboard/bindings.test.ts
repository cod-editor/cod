import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commands,
  resolveKeybinding,
  nativeKeyInput,
  formatShortcut,
  type KeyInput,
} from "../../src/keyboard.ts";
const input = (key: string, values: Partial<KeyInput> = {}): KeyInput => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...values,
});
test("native and DOM inputs match with exact platform modifiers and non-Latin fallback", () => {
  const dom = input("з", { code: "KeyP", metaKey: true, shiftKey: true });
  assert.equal(resolveKeybinding(dom, "darwin", "browser")?.command, "palette");
  assert.deepEqual(
    resolveKeybinding(
      nativeKeyInput({
        key: "з",
        code: "KeyP",
        type: "keyDown",
        meta: true,
        control: false,
        shift: true,
        alt: false,
        isComposing: false,
        isAutoRepeat: false,
      }),
      "darwin",
      "browser",
    ),
    resolveKeybinding(dom, "darwin", "browser"),
  );
  assert.equal(
    resolveKeybinding(
      { ...dom, metaKey: false, ctrlKey: true },
      "darwin",
      "browser",
    ),
    undefined,
  );
  assert.equal(
    resolveKeybinding({ ...dom, altKey: true }, "darwin", "browser"),
    undefined,
  );
  assert.equal(
    resolveKeybinding(
      input("a", { code: "KeyP", metaKey: true, shiftKey: true }),
      "darwin",
      "browser",
    ),
    undefined,
  );
  assert.equal(formatShortcut("pane.toggleLeft", "linux"), "Ctrl+Shift+B");
});
test("IME, AltGraph and releases never dispatch; held discrete commands remain consumed", () => {
  const base = input("w", { metaKey: true });
  for (const extra of [
    { isComposing: true },
    { altGraph: true },
    { keyCode: 229 },
    { type: "keyup" },
    { key: "Dead" },
  ])
    assert.equal(
      resolveKeybinding({ ...base, ...extra }, "darwin", "browser"),
      undefined,
    );
  assert.deepEqual(
    resolveKeybinding({ ...base, repeat: true }, "darwin", "browser"),
    { command: "tab.close", dispatch: false },
  );
  assert.deepEqual(
    resolveKeybinding(
      input("+", { metaKey: true, shiftKey: true, repeat: true }),
      "darwin",
      "shell",
    ),
    { command: "text.inc", dispatch: true },
  );
});
test("website and terminal editing belongs to its own surface", () => {
  for (const key of ["b", "i", "p", "f", "s", "Enter"])
    assert.equal(
      resolveKeybinding(input(key, { metaKey: true }), "darwin", "browser"),
      undefined,
    );
  for (const key of ["b", "c", "p", "n", "w", "k", "d", "r", "u", "l"])
    assert.equal(
      resolveKeybinding(input(key, { ctrlKey: true }), "linux", "terminal"),
      undefined,
    );
  assert.equal(
    resolveKeybinding(
      input("B", { ctrlKey: true, shiftKey: true }),
      "linux",
      "terminal",
    )?.command,
    "pane.toggleLeft",
  );
  assert.equal(
    resolveKeybinding(input("F6"), "linux", "browser")?.command,
    "pane.nextRegion",
  );
  assert.equal(
    resolveKeybinding(input("Tab", { ctrlKey: true }), "darwin", "terminal")
      ?.command,
    "tab.next",
  );
});
test("all declared bindings are reachable without command collisions", () => {
  const labels: Record<string, string> = { Comma: ",", Equal: "=", Minus: "-" };
  const ids = new Set();
  for (const command of commands) {
    assert.ok(!ids.has(command.id));
    ids.add(command.id);
    for (const binding of command.bindings)
      for (const platform of ["darwin", "linux"] as const) {
        if (binding.platform && binding.platform !== platform) continue;
        const key =
          labels[binding.code] ??
          binding.code.replace(/^Key/, "").replace(/^Digit/, "");
        const event = input(key, {
          code: binding.code,
          metaKey: !!binding.mod && platform === "darwin",
          ctrlKey: !!binding.ctrl || (!!binding.mod && platform === "linux"),
          shiftKey: !!binding.shift,
          altKey: !!binding.alt,
        });
        for (const surface of binding.surfaces)
          assert.equal(
            resolveKeybinding(event, platform, surface)?.command,
            command.id,
            `${command.id}/${platform}/${surface}`,
          );
      }
  }
});
