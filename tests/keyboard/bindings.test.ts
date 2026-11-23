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
    undefined,
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
  "terminal.new": ["Mod+Shift+Backquote"],
  "pane.splitRight": ["Alt+N"],
  "pane.zoom": ["Alt+Enter"],
  "pane.next": ["Alt+Tab"],
  "pane.previous": ["Alt+Shift+Tab"],
};
test("Pane cycling allows held keys with default and overridden bindings", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const mod = platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
    const altRepeat = { altKey: true, repeat: true };
    for (const [arrow, command, shiftKey] of [
      ["ArrowRight", "pane.next", false],
      ["ArrowLeft", "pane.previous", true],
    ] as const) {
      configureKeymap({}, platform);
      assert.deepEqual(
        resolveKeybinding(
          input(arrow, { ...mod, ...altRepeat }),
          platform,
          "editor",
        ),
        { command, dispatch: true },
      );
      const tab = input("Tab", { ...altRepeat, shiftKey });
      assert.equal(resolveKeybinding(tab, platform, "browser"), undefined);
      configureKeymap(personal, platform);
      for (const surface of ["terminal", "browser"] as const)
        assert.deepEqual(resolveKeybinding(tab, platform, surface), {
          command,
          dispatch: true,
        });
    }
  }
  configureKeymap({}, "darwin");
});
test("Option symbols and explicit dead-key chords use physical keys without taking ordinary composition", () => {
  configureKeymap(personal, "darwin");
  for (const [key, code, command] of [
    ["∆", "KeyJ", undefined],
    ["¡", "Digit1", "pane.focusLeft"],
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
    undefined,
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

test("Retired focus-and-return chords reach the current surface", () => {
  for (const platform of ["darwin", "linux"] as const) {
    configureKeymap({}, platform);
    const mod = platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
    for (const surface of [
      "browser",
      "composer",
      "editor",
      "terminal",
    ] as const) {
      for (const chord of [
        input("J", { ...mod, shiftKey: true }),
        input("j", { code: "KeyJ", altKey: true }),
      ])
        assert.equal(resolveKeybinding(chord, platform, surface), undefined);
    }
    for (const surface of [
      "browser",
      "agent-page",
      "composer",
      "terminal",
      "shell",
    ] as const) {
      assert.equal(
        resolveKeybinding(
          input("`", { code: "Backquote", ctrlKey: true }),
          platform,
          surface,
        )?.command,
        "terminal.quickToggle",
      );
      assert.equal(
        resolveKeybinding(
          input("`", { code: "Backquote", ctrlKey: true, repeat: true }),
          platform,
          surface,
        )?.dispatch,
        false,
      );
    }
    if (platform === "darwin")
      assert.equal(
        resolveKeybinding(
          input("`", { code: "Backquote", metaKey: true }),
          platform,
          "terminal",
        ),
        undefined,
      );
    assert.equal(
      resolveKeybinding(
        input("~", { code: "Backquote", ctrlKey: true, shiftKey: true }),
        platform,
        "terminal",
      )?.command,
      "terminal.new",
    );
  }
  configureKeymap({}, "darwin");
});

test("Default split shortcuts cover only two sides while tab selection stays available", () => {
  configureKeymap({}, "darwin");
  for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    assert.equal(
      resolveKeybinding(
        input(String(number), { code: `Digit${number}`, altKey: true }),
        "darwin",
        "browser",
      )?.command,
      number === 1
        ? "pane.focusLeft"
        : number === 2
          ? "pane.focusRight"
          : undefined,
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
    resolveKeybinding(input("Escape", { shiftKey: true }), "darwin", "review")
      ?.command,
    "pane.zoom",
  );
  assert.equal(
    resolveKeybinding(input("Enter", { altKey: true }), "darwin", "review"),
    undefined,
  );
  assert.equal(
    resolveKeybinding(input("j", { metaKey: true }), "darwin", "browser"),
    undefined,
  );
  configureKeymap(personal, "darwin");
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
  configureKeymap({}, "darwin");
});

test("browser reload uses the primary modifier and only owns the page and its browser controls", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const systemModifier = {
      metaKey: platform === "darwin",
      ctrlKey: platform === "linux",
    };
    configureKeymap({}, platform);
    for (const surface of ["browser", "browser-controls"] as const)
      assert.equal(
        resolveKeybinding(input("r", systemModifier), platform, surface)
          ?.command,
        "browser.reload",
      );
    for (const surface of [
      "editor",
      "terminal",
      "composer",
      "shell",
      "agent-page",
      "review",
    ] as const)
      assert.notEqual(
        resolveKeybinding(input("r", systemModifier), platform, surface)
          ?.command,
        "browser.reload",
      );
    assert.equal(
      resolveKeybinding(
        input("p", systemModifier),
        platform,
        "browser-controls",
      )?.command,
      resolveKeybinding(input("p", systemModifier), platform, "shell")?.command,
    );
    try {
      configureKeymap({ "browser.reload": ["Mod+Alt+R"] }, platform);
      assert.equal(
        resolveKeybinding(input("r", systemModifier), platform, "browser"),
        undefined,
      );
      assert.equal(
        resolveKeybinding(
          input("r", { ...systemModifier, altKey: true }),
          platform,
          "browser-controls",
        )?.command,
        "browser.reload",
      );
      assert.notEqual(
        resolveKeybinding(
          input("r", { ...systemModifier, altKey: true }),
          platform,
          "terminal",
        )?.command,
        "browser.reload",
      );
    } finally {
      configureKeymap({}, platform);
    }
  }
});

test("keymap overrides disable, reject unknown/conflicts atomically and never widen surface authority", () => {
  configureKeymap({}, "darwin");
  assert.equal(formatShortcut("pane.zoom", "darwin"), "⇧Esc");
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

test("Shift+Escape toggles the split without permitting plain typing shortcuts", () => {
  try {
    configureKeymap({ "pane.zoom": ["Shift+Escape"] }, "darwin");
    for (const surface of ["composer", "browser", "editor"] as const)
      assert.equal(
        resolveKeybinding(
          input("Escape", { code: "Escape", shiftKey: true }),
          "darwin",
          surface,
        )?.command,
        "pane.zoom",
      );
    assert.throws(
      () => configureKeymap({ "pane.zoom": ["Shift+A"] }, "darwin"),
      /Invalid shortcut/,
    );
    assert.throws(
      () => configureKeymap({ "pane.zoom": ["Escape"] }, "darwin"),
      /Invalid shortcut/,
    );
  } finally {
    configureKeymap({}, "darwin");
  }
});

test("Escape stops responses only in Cod chat surfaces", () => {
  try {
    for (const platform of ["darwin", "linux"] as const) {
      configureKeymap({ "chat.stop": ["Escape"] }, platform);
      for (const surface of ["composer", "shell"] as const) {
        assert.equal(
          resolveKeybinding(input("Escape"), platform, surface)?.command,
          "chat.stop",
        );
        assert.equal(
          resolveKeybinding(
            input("Escape", { repeat: true }),
            platform,
            surface,
          )?.dispatch,
          false,
        );
        assert.equal(
          resolveKeybinding(
            input("Escape", { isComposing: true }),
            platform,
            surface,
          ),
          undefined,
        );
      }
      for (const surface of [
        "browser",
        "browser-controls",
        "agent-page",
        "terminal",
        "review",
        "editor",
      ] as const) {
        assert.equal(
          resolveKeybinding(input("Escape"), platform, surface),
          undefined,
        );
      }
      configureKeymap({ "chat.stop": ["F8"] }, platform);
      assert.equal(
        resolveKeybinding(input("Escape"), platform, "composer"),
        undefined,
      );
      assert.equal(
        resolveKeybinding(input("F8"), platform, "composer")?.command,
        "chat.stop",
      );
      assert.equal(
        resolveKeybinding(input("F8"), platform, "terminal"),
        undefined,
      );
    }
  } finally {
    configureKeymap({}, "darwin");
  }
});

test("Enter sends only in the composer; Shift Enter and IME retain text editing", () => {
  configureKeymap({}, "darwin");
  for (const platform of ["darwin", "linux"] as const) {
    assert.equal(
      resolveKeybinding(input("Enter", { code: "Enter" }), platform, "composer")
        ?.command,
      "chat.send",
    );
    assert.equal(
      resolveKeybinding(
        input("Enter", { code: "Enter", repeat: true }),
        platform,
        "composer",
      )?.dispatch,
      false,
    );
    assert.equal(
      resolveKeybinding(
        input("Enter", { code: "Enter", shiftKey: true }),
        platform,
        "composer",
      ),
      undefined,
    );
    assert.equal(
      resolveKeybinding(
        input("Enter", { code: "Enter", isComposing: true }),
        platform,
        "composer",
      ),
      undefined,
    );
    for (const surface of [
      "shell",
      "editor",
      "terminal",
      "browser",
      "review",
    ] as const)
      assert.equal(
        resolveKeybinding(input("Enter", { code: "Enter" }), platform, surface),
        undefined,
      );
  }
});

test("Positional pane overrides retain declared native authority and terminal editing", () => {
  for (const platform of ["darwin", "linux"] as const) {
    try {
      configureKeymap(
        {
          "pane.toggleLeft": ["Mod+E"],
          "pane.toggleRight": ["Mod+J"],
          "pane.focusLeft": ["Alt+1"],
          "pane.focusRight": ["Alt+2"],
        },
        platform,
      );
      for (const surface of [
        "shell",
        "editor",
        "composer",
        "browser",
        "agent-page",
        "review",
        "terminal",
      ] as const) {
        for (const [key, code, command] of [
          ["e", "KeyE", "pane.toggleLeft"],
          ["j", "KeyJ", "pane.toggleRight"],
        ] as const) {
          assert.equal(
            resolveKeybinding(
              input(key, {
                code,
                metaKey: platform === "darwin",
                ctrlKey: platform === "linux",
              }),
              platform,
              surface,
            )?.command,
            platform === "linux" && surface === "terminal"
              ? undefined
              : command,
          );
        }
        for (const [digit, command] of [
          ["1", "pane.focusLeft"],
          ["2", "pane.focusRight"],
        ] as const)
          assert.equal(
            resolveKeybinding(
              input(digit, { code: `Digit${digit}`, altKey: true }),
              platform,
              surface,
            )?.command,
            command,
          );
      }
    } finally {
      configureKeymap({}, platform);
    }
  }
});

test("Developer Tools uses function keys without admitting text shortcuts or terminal editing theft", () => {
  for (const platform of ["darwin", "linux"] as const) {
    configureKeymap({}, platform);
    for (const surface of [
      "shell",
      "editor",
      "composer",
      "terminal",
      "browser",
      "agent-page",
    ] as const)
      assert.equal(
        resolveKeybinding(input("F12"), platform, surface)?.command,
        "devtools.toggle",
      );
    configureKeymap({ "devtools.toggle": ["F12"] }, platform);
    assert.equal(
      resolveKeybinding(input("F12"), platform, "browser")?.command,
      "devtools.toggle",
    );
    assert.throws(() =>
      configureKeymap({ "devtools.toggle": ["i"] }, platform),
    );
    configureKeymap({}, platform);
  }
  configureKeymap({ "devtools.toggle": ["Mod+K"] }, "linux");
  assert.equal(
    resolveKeybinding(input("k", { ctrlKey: true }), "linux", "shell")?.command,
    "devtools.toggle",
  );
  assert.equal(
    resolveKeybinding(input("k", { ctrlKey: true }), "linux", "terminal"),
    undefined,
  );
  configureKeymap({}, "linux");
});

test("Shortcut labels follow the command's effective platform and content scope", () => {
  try {
    configureKeymap({}, "linux");
    assert.equal(formatShortcut("files.save", "linux", "shell"), "");
    assert.equal(formatShortcut("files.save", "linux", "editor"), "Ctrl+S");
    configureKeymap({ "files.save": ["Alt+Q"] }, "darwin");
    assert.equal(formatShortcut("files.save", "darwin", "editor"), "⌥Q");
    assert.equal(formatShortcut("files.save", "darwin", "review"), "");
    configureKeymap({ "files.save": null }, "darwin");
    assert.equal(formatShortcut("files.save", "darwin", "editor"), "");
  } finally {
    configureKeymap({}, "linux");
  }
});
