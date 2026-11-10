export type KeyboardPlatform = "darwin" | "linux";
export type KeyboardSurface =
  | "shell"
  | "editor"
  | "composer"
  | "terminal"
  | "browser"
  | "agent-page"
  | "review";
export interface KeyInput {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  altGraph?: boolean;
  type?: string;
  keyCode?: number;
}
export interface KeyBinding {
  code: string;
  mod?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  platform?: KeyboardPlatform;
  surfaces: readonly KeyboardSurface[];
  repeat?: boolean;
}
const all: readonly KeyboardSurface[] = [
  "shell",
  "editor",
  "composer",
  "terminal",
  "browser",
  "agent-page",
  "review",
];
const cod: readonly KeyboardSurface[] = [
  "shell",
  "editor",
  "composer",
  "review",
];
const host: readonly KeyboardSurface[] = [...cod, "terminal"];
const key = (
  code: string,
  options: Omit<KeyBinding, "code" | "surfaces"> = {},
  surfaces = all,
): KeyBinding => ({ code, ...options, surfaces });
// Terminal control keys and website editing shortcuts remain with their owners.
const desktop = (code: string, shift = false): KeyBinding[] => [
  key(code, { mod: true, shift, platform: "darwin" }),
  key(code, { mod: true, shift, platform: "linux" }, cod),
];
const entry = <T extends string>(
  id: T,
  title: string,
  category: string,
  bindings: KeyBinding[] = [],
  aliases: readonly string[] = [],
) => ({ id, title, category, bindings, aliases });
export const commands = [
  entry("shortcuts.openFile", "Open keyboard shortcuts file", "Application"),
  entry(
    "palette",
    "Commands",
    "Application",
    [key("KeyP", { mod: true, shift: true })],
    ["command palette"],
  ),
  entry(
    "shortcuts",
    "Keyboard shortcuts",
    "Application",
    [],
    ["keymap", "hotkeys", "bindings"],
  ),
  entry("settings", "Settings...", "Application", [
    key("Comma", { mod: true }),
  ]),
  entry("workspace.new", "New workspace", "Workspace", [
    key("KeyN", { mod: true, shift: true }),
  ]),
  entry("chat.new", "New chat", "Conversation", desktop("KeyN"), [
    "new conversation",
    "open chat",
    "start chat",
    "new session",
    "open session",
    "start session",
  ]),
  entry("workspace.focusTree", "Focus workspaces / return", "Navigation", [
    key("KeyW", { mod: true, shift: true }),
  ]),
  entry("files.open", "Open file", "Files", [
    key("KeyP", { mod: true, platform: "darwin" }, host),
    key("KeyP", { mod: true, platform: "linux" }, cod),
  ]),
  entry("files.search", "Search in files", "Files", [
    key("KeyF", { mod: true, shift: true }, host),
  ]),
  entry("content.find", "Find in current content", "Search", [
    key("KeyF", { mod: true, platform: "darwin" }),
    key("KeyF", { mod: true, platform: "linux" }, [
      ...cod,
      "browser",
      "agent-page",
    ]),
  ]),
  entry("files.save", "Save file", "Files", [
    key("KeyS", { mod: true }, ["editor"]),
  ]),
  entry("pane.toggleLeft", "Toggle material area", "Layout"),
  entry("pane.toggleRight", "Toggle chat area", "Layout", [
    key("KeyJ", { mod: true, platform: "darwin" }),
    key("KeyJ", { mod: true, platform: "linux" }, [
      ...cod,
      "browser",
      "agent-page",
    ]),
  ]),
  entry("pane.zoom", "Maximize / restore pane", "Layout", [
    key("Enter", { mod: true, shift: true }, all),
  ]),
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((number) =>
    entry(
      `pane.focus${number}` as const,
      `Focus pane ${number}`,
      "Navigation",
      [key(`Digit${number}`, { mod: true, alt: true })],
    ),
  ),
  entry("pane.next", "Focus next pane", "Navigation", [
    key("ArrowRight", { mod: true, alt: true }),
  ]),
  entry("pane.previous", "Focus previous pane", "Navigation", [
    key("ArrowLeft", { mod: true, alt: true }),
  ]),
  entry("pane.nextRegion", "Focus next area", "Navigation"),
  entry("pane.previousRegion", "Focus previous area", "Navigation"),
  entry("tab.next", "Next tab", "Navigation", [key("Tab", { ctrl: true })]),
  entry("tab.previous", "Previous tab", "Navigation", [
    key("Tab", { ctrl: true, shift: true }),
  ]),
  ...([1, 2, 3, 4, 5, 6, 7, 8] as const).map((number) =>
    entry(`tab.focus${number}` as const, `Select tab ${number}`, "Tabs", [
      key(`Digit${number}`, { mod: true }),
    ]),
  ),
  entry("tab.last", "Select last tab", "Tabs", [key("Digit9", { mod: true })]),
  entry("tab.close", "Close tab", "Tabs", [
    key("KeyW", { mod: true, platform: "darwin" }),
    key("KeyW", { mod: true, platform: "linux" }, [
      ...cod,
      "browser",
      "agent-page",
    ]),
  ]),
  entry("tab.reopen", "Reopen closed tab", "Tabs", [
    key("KeyT", { mod: true, shift: true }),
  ]),
  entry("browser.address", "Focus address bar", "Browser", [
    key("KeyL", { mod: true }, [...cod, "browser"]),
  ]),
  entry("chat.send", "Send message", "Conversation", [
    key("Enter", { mod: true }, ["composer"]),
  ]),
  entry("text.inc", "Increase text size", "Appearance", [
    key("Equal", { mod: true, repeat: true }, host),
    key("Equal", { mod: true, shift: true, repeat: true }, host),
  ]),
  entry("text.dec", "Decrease text size", "Appearance", [
    key("Minus", { mod: true, repeat: true }, host),
  ]),
  entry("text.reset", "Reset text size", "Appearance", [
    key("Digit0", { mod: true }, host),
  ]),
  entry("focus.files", "Focus files / return", "Navigation", [
    key("KeyE", { mod: true, shift: true }),
  ]),
  entry("focus.composer", "Focus chat / return", "Navigation", [
    key("KeyJ", { mod: true, shift: true }),
  ]),
  entry("focus.terminal", "Focus terminal / return", "Navigation", [
    key("Backquote", { ctrl: true }),
  ]),
  entry("tab.reorderLeft", "Move tab left", "Tabs"),
  entry("tab.reorderRight", "Move tab right", "Tabs"),
  entry("tab.moveToPane", "Move tab to another pane", "Tabs"),
  entry("pane.splitRight", "Split right", "Layout", [
    key("Backslash", { mod: true }),
  ]),
  entry("pane.splitDown", "Split below", "Layout", [
    key("Backslash", { mod: true, shift: true }),
  ]),
  entry("terminal.new", "New terminal", "Terminal", [
    key("Backquote", { ctrl: true, shift: true }),
  ]),
  entry("browser.new", "New browser tab", "Browser"),
  entry("folders.add", "Add folder", "Workspace"),
  entry("review.document", "Review active document", "Review"),
  entry("chat.stop", "Stop response", "Conversation"),
  entry("review.addComment", "Add review comment", "Review", [
    key("KeyM", { mod: true, shift: true }, ["review"]),
  ]),
  entry("review.submit", "Send review feedback", "Review"),
  entry("workspace.rename", "Rename workspace", "Workspace"),
  entry("session.resume", "Open existing native session", "Conversation"),
  entry("chat.width", "Chat maximum width", "Appearance"),
  entry("integration.install", "Install agent integration...", "Conversation"),
  entry("browser.default", "Default browser...", "Browser"),
  entry("navigation.toggleFiles", "Toggle files", "Navigation", [
    key("KeyB", { mod: true, platform: "darwin" }, host),
    key("KeyB", { mod: true, platform: "linux" }, cod),
  ]),
  entry("navigation.toggleWorkspaces", "Toggle workspaces", "Navigation", [
    key("KeyB", { mod: true, shift: true }),
  ]),
  entry("workspace.reopen", "Reopen closed workspace", "Workspace"),
] as const;
export type CommandId = (typeof commands)[number]["id"];

function normalizedCode(input: KeyInput): string | undefined {
  // Option changes the produced character (and may begin a dead key). Only
  // declared exact-modifier bindings consume its physical-key identity.
  if (input.altKey && input.code) return input.code;
  if (/^[a-z]$/i.test(input.key)) return `Key${input.key.toUpperCase()}`;
  if (/^[0-9]$/.test(input.key)) return `Digit${input.key}`;
  const punctuation: Record<string, string> = {
    ",": "Comma",
    "+": "Equal",
    "=": "Equal",
    "-": "Minus",
    "`": "Backquote",
    "~": "Backquote",
    "\\": "Backslash",
    "|": "Backslash",
  };
  if (punctuation[input.key]) return punctuation[input.key];
  if (
    [
      "Enter",
      "Escape",
      "Tab",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Space",
    ].includes(input.key) ||
    /^F(?:[1-9]|1[0-2])$/.test(input.key)
  )
    return input.key;
  // Physical letter position keeps shortcuts reachable on non-Latin layouts,
  // while Latin layouts (including Dvorak/AZERTY) retain their logical letters.
  if (
    /^\p{Letter}$/u.test(input.key) &&
    input.code &&
    /^Key[A-Z]$/.test(input.code)
  )
    return input.code;
  return undefined;
}
export function resolveKeybinding(
  input: KeyInput,
  platform: KeyboardPlatform,
  surface: KeyboardSurface,
): { command: CommandId; dispatch: boolean } | undefined {
  if (input.type && !["keydown", "keyDown"].includes(input.type)) return;
  if (
    input.isComposing ||
    input.keyCode === 229 ||
    input.altGraph ||
    ["Process", "Unidentified", "AltGraph"].includes(input.key) ||
    (input.key === "Dead" && !input.altKey)
  )
    return;
  const code = normalizedCode(input);
  for (const command of commands)
    for (const binding of command.bindings) {
      if (
        (binding.platform && binding.platform !== platform) ||
        !binding.surfaces.includes(surface) ||
        binding.code !== code
      )
        continue;
      const ctrl = !!binding.ctrl || (!!binding.mod && platform !== "darwin");
      const meta = !!binding.mod && platform === "darwin";
      if (
        input.ctrlKey !== ctrl ||
        input.metaKey !== meta ||
        input.shiftKey !== !!binding.shift ||
        input.altKey !== !!binding.alt
      )
        continue;
      return {
        command: command.id,
        dispatch: !input.repeat || !!binding.repeat,
      };
    }
}
export function formatBinding(
  binding: KeyBinding,
  platform: KeyboardPlatform,
): string {
  const name = binding.code.replace(/^Key/, "").replace(/^Digit/, "");
  const label: Record<string, string> = {
    Comma: ",",
    Equal: binding.shift ? "+" : "=",
    Minus: "-",
    Escape: "Esc",
    Enter: "Enter",
    Backquote: "`",
    Backslash: "\\",
  };
  const parts = [
    binding.mod
      ? platform === "darwin"
        ? "⌘"
        : "Ctrl"
      : binding.ctrl
        ? platform === "darwin"
          ? "⌃"
          : "Ctrl"
        : "",
    binding.alt ? (platform === "darwin" ? "⌥" : "Alt") : "",
    binding.shift ? (platform === "darwin" ? "⇧" : "Shift") : "",
    label[name] ?? name,
  ].filter(Boolean);
  return parts.join(platform === "darwin" ? "" : "+");
}
export function formatShortcut(
  id: CommandId,
  platform: KeyboardPlatform,
): string {
  const binding = commands
    .find((command) => command.id === id)
    ?.bindings.find((item) => !item.platform || item.platform === platform);
  return binding ? formatBinding(binding, platform) : "";
}

export function nativeKeyInput(input: {
  key: string;
  code: string;
  type: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  isAutoRepeat: boolean;
  isComposing: boolean;
  modifiers?: string[];
}): KeyInput {
  return {
    key: input.key,
    code: input.code,
    type: input.type,
    ctrlKey: input.control,
    metaKey: input.meta,
    shiftKey: input.shift,
    altKey: input.alt,
    repeat: input.isAutoRepeat,
    isComposing: input.isComposing,
    altGraph:
      input.modifiers?.some((modifier) =>
        ["altgr", "altgraph"].includes(modifier.toLowerCase()),
      ) ?? false,
  };
}

/** Local control gestures are reference text, never executable app commands. */
export const localGestures: readonly {
  title: string;
  keys: readonly string[];
  context: string;
  aliases?: readonly string[];
}[] = [
  {
    title: "Move through controls",
    keys: ["Tab", "Shift+Tab"],
    context: "Within the focused area or dialog",
    aliases: ["focus", "next", "previous"],
  },
  {
    title: "Dismiss dialog",
    keys: ["Escape"],
    context: "Open dialog; returns to its previous focus",
    aliases: ["cancel", "close"],
  },
  {
    title: "Navigate tree",
    keys: ["Up", "Down", "Home", "End"],
    context: "Workspace and file trees",
    aliases: ["arrow", "row", "first", "last"],
  },
  {
    title: "Expand or enter folder",
    keys: ["Right"],
    context: "File tree; expands workspace rows in the workspace tree",
    aliases: ["arrow", "expand"],
  },
  {
    title: "Collapse or go to parent",
    keys: ["Left"],
    context: "Workspace and file trees",
    aliases: ["arrow", "collapse"],
  },
  {
    title: "Open selected item",
    keys: ["Enter"],
    context: "Trees and search results",
    aliases: ["activate", "select"],
  },
  {
    title: "Open context menu",
    keys: ["Shift+F10", "Menu"],
    context: "Focused Cod control with a context menu",
    aliases: ["actions", "right click"],
  },
  {
    title: "Select review lines",
    keys: ["Shift+Up", "Shift+Down", "Shift+Home", "Shift+End"],
    context: "Review source lines",
    aliases: ["range", "comment"],
  },
  {
    title: "Navigate tabs",
    keys: ["Left", "Right"],
    context: "Focused tab strip",
    aliases: ["arrow"],
  },
];

export type KeymapOverrides = Partial<Record<CommandId, string[] | null>>;
export interface KeymapState {
  path: string;
  overrides: KeymapOverrides;
  error?: string;
}
const defaultBindings = new Map(
  commands.map((command) => [
    command.id,
    command.bindings.map((binding) => ({ ...binding })),
  ]),
);

/** Parse portable shortcuts: Mod, Cmd/Meta, Ctrl, Alt/Option, Shift plus one key. */
function parseShortcut(
  shortcut: string,
  platform: KeyboardPlatform,
): KeyBinding {
  const parts = shortcut.split("+").map((part) => part.trim());
  const value = parts.pop() ?? "";
  const binding: KeyBinding = { code: "", surfaces: [], platform };
  for (const modifier of parts) {
    switch (modifier.toLowerCase()) {
      case "mod":
        binding.mod = true;
        break;
      case "cmd":
      case "meta":
        if (platform !== "darwin")
          throw new Error("Cmd/Meta shortcuts require macOS");
        binding.mod = true;
        break;
      case "ctrl":
      case "control":
        binding.ctrl = true;
        break;
      case "alt":
      case "option":
        binding.alt = true;
        break;
      case "shift":
        binding.shift = true;
        break;
      default:
        throw new Error(`Unknown modifier: ${modifier}`);
    }
  }
  const names: Record<string, string> = {
    enter: "Enter",
    tab: "Tab",
    escape: "Escape",
    comma: "Comma",
    backquote: "Backquote",
    backslash: "Backslash",
    minus: "Minus",
    equal: "Equal",
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
    space: "Space",
  };
  binding.code =
    names[value.toLowerCase()] ??
    normalizedCode({
      key: value,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    }) ??
    (/^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2]))$/.test(value) ? value : "");
  if (!binding.code || (!binding.mod && !binding.ctrl && !binding.alt))
    throw new Error(`Invalid shortcut: ${shortcut}`);
  return binding;
}

/** Atomic validation: invalid files never install a partial or privileged keymap. */
export function configureKeymap(
  value: unknown,
  platform: KeyboardPlatform,
): KeymapOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Keymap must be an object of command IDs and shortcut arrays or null",
    );
  const overrides: KeymapOverrides = {};
  const effective = new Map(defaultBindings);
  for (const [id, shortcuts] of Object.entries(value)) {
    const command = commands.find((command) => command.id === id);
    if (!command) throw new Error(`Unknown command: ${id}`);
    if (
      shortcuts !== null &&
      (!Array.isArray(shortcuts) ||
        shortcuts.some((item) => typeof item !== "string") ||
        shortcuts.length > 8)
    )
      throw new Error(`Invalid shortcuts for ${id}`);
    const inherited = (defaultBindings.get(command.id) ?? []).filter(
      (binding) => !binding.platform || binding.platform === platform,
    );
    const surfaces = [
      ...new Set(inherited.flatMap((binding) => binding.surfaces)),
    ];
    // Palette-only commands stay within Cod; overrides cannot grant page authority.
    const scope = surfaces.length ? surfaces : cod;
    const bindings = (shortcuts ?? []).map((shortcut: string) => {
      const parsed = parseShortcut(shortcut, platform);
      const terminalConflict =
        platform === "linux" &&
        (parsed.ctrl || parsed.mod) &&
        !parsed.alt &&
        !parsed.shift &&
        /^Key[A-Z]$/.test(parsed.code);
      return {
        ...parsed,
        surfaces: terminalConflict
          ? scope.filter((surface) => surface !== "terminal")
          : scope,
        repeat: inherited.some((binding) => binding.repeat),
      };
    });
    effective.set(command.id, bindings);
    overrides[command.id] = shortcuts;
  }
  const occupied = new Map<string, string>();
  for (const [id, bindings] of effective)
    for (const binding of bindings) {
      if (binding.platform && binding.platform !== platform) continue;
      for (const surface of binding.surfaces) {
        const signature = [
          surface,
          binding.code,
          !!binding.mod && platform === "darwin",
          !!binding.ctrl || (!!binding.mod && platform === "linux"),
          !!binding.alt,
          !!binding.shift,
        ].join(":");
        const owner = occupied.get(signature);
        if (owner && owner !== id)
          throw new Error(`Shortcut conflict: ${owner} and ${id}`);
        occupied.set(signature, id);
      }
    }
  for (const command of commands)
    command.bindings.splice(
      0,
      command.bindings.length,
      ...(effective.get(command.id) ?? []),
    );
  return overrides;
}
