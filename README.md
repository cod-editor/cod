# Cod

A local desktop workspace for coding agents: conversations, repositories, files, reviews, terminals and browser tabs in one window. Workspaces restore their layout and saved work; the CLI exposes the same operations as the interface.

This is an **alpha** Electron-based replacement for the previous Zed-based Cod, not a stable release. The previous implementation is preserved at [legacy-zed-2026-11-10](https://github.com/cod-editor/cod/tree/legacy-zed-2026-11-10).

## Run

Requires Node.js 24+, npm and the native coding-agent CLIs you want to use. Linux needs Electron's system libraries and a graphical display.

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run prepare:bitwarden
npm start
```

Dependency install scripts are disabled because the PTY package ships native prebuilds. Electron's explicit installer downloads its prebuilt runtime. Provider authentication stays in the provider's own tools; Cod does not replace it.

Development and packaged builds share the default profile: `~/Library/Application Support/Cod` on macOS, `$XDG_CONFIG_HOME/cod` (or `~/.config/cod`) on Linux, and `%APPDATA%/Cod` on Windows.

A new workspace starts with a chat. Enter sends; Shift+Enter inserts a newline. Cmd/Ctrl+Enter also sends. Cmd/Ctrl+Shift+P opens Commands, Cmd/Ctrl+Shift+E focuses files, and Cmd/Ctrl+S saves a file. Workspace and tab context menus contain management actions. Reviews send feedback to the conversation that requested them; draft comments remain private until submission.

Remove from workspace in a session's context menu clears it from the workspace without deleting its native history. Reopen closed tab restores the removed chat and draft; the native session remains available in the provider's CLI. Stop active work and finish pending reviews or form submissions before removing the session.

Keyboard shortcuts is searchable from Commands, Settings and the Help menu. Focus commands reveal files, workspaces, chat or terminal and return to the previous control on a second press; Tab moves through local controls. Trees and tab bars use arrow keys, and Shift+F10 opens context actions. The reference shows platform defaults and their contexts: web editing and terminal control keys stay with the page or shell, while Find in current content searches the active editor, conversation, terminal or embedded page. Open keyboard shortcuts file from Commands or the reference to edit `keymap.json` in Cod's data directory. Map command IDs to shortcut arrays (for example, `"focus.composer": ["Alt+J"]`) or `null` to disable a binding. `Mod` means Command on macOS and Control elsewhere. Changes reload automatically; an invalid file falls back to defaults and shows its error in the reference.

While Cod runs:

```sh
npm run codctl -- --help
npm run codctl -- workspace create --name "Documentation"
npm run codctl -- workspace add-folder --id WORKSPACE_ID --path /path/to/repository
npm run codctl -- file open --workspace WORKSPACE_ID --path /path/to/spec.md
npm run codctl -- state
```

CLI creation stays in the background unless focus is explicitly requested. Set `COD_DATA_DIR` and `COD_SOCKET_PATH` for a separate application instance. Runtime operating instructions are in [runtime-skills/cod/SKILL.md](runtime-skills/cod/SKILL.md).

## Current limits

The workspace panel lists conversations and browser tabs. New tab (`Cmd/Ctrl+T` or a pane's `+`) opens a blank tab offering File, Browser, Chat and Terminal; direct creation commands remain available. Drag tabs to the insertion marker to reorder or move between panes; context menus provide keyboard alternatives. Blank tabs and tab order survive restart.

PNG, JPEG, GIF and WebP files open in Cod's image preview, with fit-to-pane, actual size, zoom and scrolling. Focus the preview and use `0` to fit, `1` for actual size and `+` / `-` to zoom; the same actions are in its context menu. Images are limited to 20 MiB. Explicit absolute file links can open files outside workspace folders, including Downloads; relative references are resolved inside workspace folders. Automatic inline image loading stays limited to workspace files.

New browser tabs show pinned sites shared across workspaces. Use the `+` tile to add a site, its context menu to rename or unpin it, or Commands > Pin current site to home. The address field accepts website addresses without a scheme and searches ordinary text with Google. Ordinary new-tab links stay in workspace tabs and preserve native opener/form behavior; explicit popups remain separate windows. Closed and restarted tabs retain up to 50 URL/title navigation entries. Form contents and POST payloads are not restored. There is no recent-sites section or bookmarks bar. Address suggestions use local history and pinned sites without sending typed text to a server. Commands > Browsing history searches and clears history; a result's context menu removes that entry. Browser settings selects Google, DuckDuckGo, Bing or Yandex. Optional bookmarks are available through Commands > Bookmark current page and Bookmarks (search, edit and remove). They also appear in address suggestions, but add no permanent panel and do not change home pins.

- Chats support Codex and Kimi, including images and native-session handoff. Sending while busy queues the message; waiting messages can be edited or cancelled above the composer. Queues survive restart and then require explicit continuation. Attached Codex chats display externally queued turns from `codex queue --thread NATIVE_SESSION_ID --message TEXT`, including replies and completion status. Background command exit alone does not enqueue a continuation. Kimi currently reports some native failures as an empty successful ACP completion; Cod reports a missing response instead, but the precise cause may require the Kimi CLI or its native log. Claude remains a product requirement but is not available in the selector.
- Session commands (`/help`, `/status`, `/skills`, `/plugins`, `/config`, `/agents`) inspect native data without sending a prompt. Codex skill selection attaches the native skill to the next prompt. Configuration and plugin changes, and direct child-agent control, remain in the native client. Token usage appears only after provider telemetry; account limits are available only when Codex supplies them.
- Bitwarden is pinned and bundled in packages. Its installed path stays within the Cod profile across package updates. Upgrading from older releases that loaded it directly from a timestamped package may require one final sign-in; their old extension storage is preserved without attempting a partial authentication migration. After the first vault login, reload an already-open page once before autofill. The verified save path is the extension's vault UI; automatic capture of a submitted login is not established. Arbitrary extensions are unsupported.
- Ad blocking uses an existing engine with a per-site toggle. Fixture tests do not establish equivalence to AdGuard on every site. Camera, microphone, location, notification, clipboard, fullscreen and pointer-lock requests require an explicit per-site decision. Choose Allow once, Always allow or Block; use Site permissions in Commands or the site-protection menu to revoke remembered access. OS-level permission can still be required. Screen sharing and device selectors for USB/Bluetooth are not implemented.
- The optional [status integration](runtime-plugins/cod/README.md) installs hooks only after a profile preview. Native trust and authentication requirements still apply; successful installation is not proof that the provider executed its hooks.
- Terminal processes do not survive quitting Cod. Restored terminals use fresh shells and never replay old commands. Disowned or HUP-resistant jobs are outside ordinary foreground cleanup guarantees.
- Registered HTML artifacts may submit to their originating conversation. General agent browser control, a mailbox and cloud execution are out of scope.
- Recent graphical acceptance used isolated Linux Electron. The current macOS bundle has CLI/PTY checks and a local ad-hoc signature; it is not notarized, and its final GUI and system default-browser action have not been verified on macOS.

Downloads are available in Commands and from the browser toolbar once a file has been downloaded. Pause, resume, cancel, retry, open and reveal files there. Closing a tab keeps its download running. Download history survives restart; interrupted transfers require an explicit retry. Removing an entry does not delete the file.

Pin important views through the tab context menu or Commands > Toggle pin tab. Pinned tabs stay first, replace their close button with an unpin icon and survive ordinary or bulk closure. Explicit Close tab in the context menu still closes them; Reopen closed tab restores their pin. Moves and restart retain pins. Optional shortcuts use the existing keymap settings.

Manual Developer Tools are available with F12 or Commands > Toggle Developer Tools. The inspector follows the focused surface: Cod UI controls/chat/files inspect Cod, native page content inspects that exact page. Ordinary browser context menus also offer Inspect element. The alternate shortcut is Command+Option+I on macOS and Ctrl+Shift+I on Linux; optional overrides use the shared keymap. Close the detached inspector with its native controls, or toggle it again from the inspected surface.

## Development

Read [AGENTS.md](AGENTS.md), [the requirements](docs/vision.md) and [implementation contracts](docs/specs/implementation.md).

- `npm run build`: bundle the application and CLI.
- `npm run check`: formatting and TypeScript checks.
- `npm run test:unit`: unit and CLI protocol checks; run `npm run build` first.
- `npm run test:providers`: provider subprocess tests, without live accounts.
- `npm run test:integration`: status-plugin tests using temporary profiles.
- `npm run test:isolated`: real Electron acceptance in Docker/Xvfb. It requires the configured Linux test image; see [test environments](tests/README.md).
- `npm run test:e2e`: the same selected application tests on the current graphical display. Do not run these on somebody's active desktop.
- `npm run format`: format supported source files.

On macOS, prefix long jobs with `caffeinate -dimsu`. Native provider and official extension compatibility checks are separate from deterministic fixture tests.

## Package locally

Run `npm run build`, then `node scripts/package.mjs`. The package is written to `release/cod-PLATFORM-ARCH-TIMESTAMP/`, with the application, a `codctl` launcher and input hashes. It includes the pinned Bitwarden extension and runtime instructions, but no provider credentials or development dependencies. Packaging uses the host platform's Electron and PTY prebuilds; cross-copying dependencies between macOS and Linux is unsupported.

On macOS the script signs the bundle ad hoc. `node tests/support/electron/check-package.mjs release/PACKAGE_DIRECTORY` checks its signature, CLI, native PTY and included assets without opening a window. This does not replace isolated graphical release testing or notarization.

## License

Copyright (C) 2026 Mikhail Butvin. GNU GPL version 3 or later; see [LICENSE](LICENSE). Versions preceding the license change were released under the MIT License.

## Local diagnostics

Cod writes a local rotating journal under `diagnostics/` in its data directory (`~/Library/Application Support/Cod/diagnostics` on macOS). `runtime.jsonl` and up to three rotated files contain startup/shutdown, renderer and child-process exits, responsiveness events, and memory samples every 30 seconds. The journal is limited to about 4 MiB. Samples include Electron process memory (in KiB), main-process Node memory (in bytes), and available system memory. Samples map renderer PIDs and WebContents IDs to opaque browser-tab and workspace IDs, including registered pages and browser popups. Renderer failure events retain the last known PID so they can be correlated with earlier samples. Several views can share a renderer process; the main application renderer hosts multiple workspaces and is identified as application-wide. Separate provider CLI processes are not included. Chat text, file contents, URLs and arbitrary error messages are not recorded. Nothing is uploaded. Close-tab diagnostics record only the close chord modifiers, the recognized command and the operation outcome/timing; they do not record ordinary keystrokes or message text.

An unfinished session is reported at the next startup; this alone does not distinguish a crash, force quit or system shutdown. A sudden OS kill may leave only the last periodic sample. Restart Cod after updating to enable diagnostics; older runs cannot be reconstructed.

## Settings

Open Settings from Commands or the platform settings shortcut. Search by area or setting name. Appearance changes apply to open views and persist in `settings.json` beside the data file; Edit settings.json opens it in your system editor. Keyboard shortcuts opens the searchable reference and existing `keymap.json`. The browser search engine is searchable in the same window and stays in the browser profile library; Browser settings in Commands opens that section. Workspace-specific chat width takes precedence over the global width.

Font family fields accept CSS font-family lists for installed fonts. Font sizes are in pixels; line heights are multipliers. Terminal settings include block/bar/underline cursor, blinking and scrollback. Editor settings include tab display width and long-line wrapping; tab width does not rewrite file indentation. The source editor uses the platform text caret; changing its shape is not supported. Settings currently cover these implemented controls, not the full extension, theme and language configuration surface of VS Code or Zed.

Files use strict JSON with flat keys, for example:

```json
{
  "editor.fontFamily": "JetBrains Mono, monospace",
  "editor.fontSize": 16,
  "terminal.cursorStyle": "bar",
  "terminal.cursorBlink": true,
  "chat.maxWidth": 1000
}
```

Invalid settings keep the last working values and display an error in Settings. Repair the file to resume applying changes. Reset restores defaults. Existing text-size preferences are imported once. CLI access uses `codctl settings get` and `codctl settings update --values '{"terminal.cursorStyle":"bar"}'`; `--reset true` resets appearance settings and the browser search engine, preserving keybindings, bookmarks, pins and browsing history. A failure in either settings store is reported; a partial reset is never reported as complete.
