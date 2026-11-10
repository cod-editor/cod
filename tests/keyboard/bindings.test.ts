import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commands,
  configureKeymap,
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
  assert.equal(
    formatShortcut("navigation.toggleWorkspaces", "linux"),
    "Ctrl+Shift+B",
  );
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
  for (const key of ["b", "i", "p", "s", "Enter"])
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
    "navigation.toggleWorkspaces",
  );
  assert.equal(
    resolveKeybinding(input("F6"), "linux", "browser")?.command,
    undefined,
  );
  assert.equal(
    resolveKeybinding(input("Tab", { ctrlKey: true }), "darwin", "terminal")
      ?.command,
    "tab.next",
  );
});
test("all declared bindings are reachable without command collisions", () => {
  const labels: Record<string, string> = {
    Comma: ",",
    Equal: "=",
    Minus: "-",
    Backquote: "`",
    Backslash: "\\",
  };
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

const personal = {
  "focus.composer": ["Alt+J"],
  "focus.terminal": ["Mod+Backquote"],
  "terminal.new": ["Mod+Shift+Backquote"],
  "pane.splitRight": ["Alt+N"],
  "pane.splitDown": ["Alt+Shift+N"],
  "pane.zoom": ["Alt+Enter"],
  "pane.next": ["Alt+Tab"],
  "pane.previous": ["Alt+Shift+Tab"],
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`pane.focus${n}`, [`Alt+${n}`]]),
  ),
};
test("Option symbols and explicit dead-key chords use physical keys without taking ordinary composition", () => {
  configureKeymap(personal, "darwin");
  for (const [key, code, command] of [
    ["∆", "KeyJ", "focus.composer"],
    ["¡", "Digit1", "pane.focus1"],
    ["Dead", "KeyN", "pane.splitRight"],
    ["å", "KeyA", undefined],
    ["∫", "KeyB", undefined],
  ] as const) {
    const event = input(key, { code, altKey: true });
    assert.equal(
      resolveKeybinding(event, "darwin", "composer")?.command,
      command,
    );
    assert.equal(
      resolveKeybinding({ ...event, isComposing: true }, "darwin", "composer"),
      undefined,
    );
    assert.equal(
      resolveKeybinding({ ...event, keyCode: 229 }, "darwin", "composer"),
      undefined,
    );
    assert.equal(
      resolveKeybinding({ ...event, altGraph: true }, "darwin", "composer"),
      undefined,
    );
  }
  assert.equal(
    resolveKeybinding(input("Dead", { code: "KeyN" }), "darwin", "composer"),
    undefined,
  );
  assert.equal(
    resolveKeybinding(
      input("~", { code: "KeyN", altKey: true, shiftKey: true }),
      "darwin",
      "browser",
    )?.command,
    "pane.splitDown",
  );
  assert.equal(
    resolveKeybinding(
      input("`", { code: "Backquote", metaKey: true }),
      "darwin",
      "terminal",
    )?.command,
    "focus.terminal",
  );
  assert.equal(
    resolveKeybinding(
      input("~", { code: "Backquote", metaKey: true, shiftKey: true }),
      "darwin",
      "shell",
    )?.command,
    "terminal.new",
  );
});

test("approved numeric selection, find and zoom bindings replace old defaults", () => {
  for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    assert.equal(
      resolveKeybinding(
        input(String(number), { code: `Digit${number}`, altKey: true }),
        "darwin",
        "browser",
      )?.command,
      `pane.focus${number}`,
    );
    assert.equal(
      resolveKeybinding(
        input(String(number), { metaKey: true }),
        "darwin",
        "browser",
      )?.command,
      number === 9 ? "tab.last" : `tab.focus${number}`,
    );
  }
  assert.equal(
    resolveKeybinding(input("f", { metaKey: true }), "darwin", "browser")
      ?.command,
    "content.find",
  );
  assert.equal(
    resolveKeybinding(input("Enter", { altKey: true }), "darwin", "review")
      ?.command,
    "pane.zoom",
  );
  assert.equal(
    resolveKeybinding(input("Tab", { altKey: true }), "darwin", "browser")
      ?.command,
    "pane.next",
  );
  assert.equal(
    resolveKeybinding(
      input("Tab", { altKey: true, shiftKey: true }),
      "darwin",
      "browser",
    )?.command,
    "pane.previous",
  );
  assert.equal(
    resolveKeybinding(input("Tab", { metaKey: true }), "darwin", "browser"),
    undefined,
  );
  assert.equal(resolveKeybinding(input("F6"), "darwin", "shell"), undefined);
});

test("keymap overrides disable, reject unknown/conflicts atomically and never widen surface authority", () => {
  configureKeymap({}, "darwin");
  assert.equal(formatShortcut("pane.zoom", "darwin"), "⌘⇧Enter");
  configureKeymap({ settings: null, "files.save": ["Mod+Alt+S"] }, "darwin");
  assert.equal(formatShortcut("settings", "darwin"), "");
  assert.equal(
    resolveKeybinding(input("b", { metaKey: true }), "darwin", "browser"),
    undefined,
  );
  assert.throws(
    () => configureKeymap({ bogus: ["Mod+A"] }, "darwin"),
    /Unknown command/,
  );
  assert.equal(formatShortcut("settings", "darwin"), "");
  assert.throws(
    () => configureKeymap({ settings: ["Mod+Shift+P"] }, "darwin"),
    /conflict/,
  );
  configureKeymap({}, "darwin");
  assert.equal(
    resolveKeybinding(input("Tab", { ctrlKey: true }), "darwin", "browser")
      ?.command,
    "tab.next",
  );
  assert.equal(
    resolveKeybinding(input("Tab", { metaKey: true }), "darwin", "browser"),
    undefined,
  );
  configureKeymap({ "chat.new": ["Ctrl+K"] }, "linux");
  assert.equal(
    resolveKeybinding(input("k", { ctrlKey: true }), "linux", "terminal"),
    undefined,
  );
  configureKeymap({}, "darwin");
});
