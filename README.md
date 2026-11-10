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

A new workspace starts with a chat. Cmd/Ctrl+Enter sends; Enter inserts a newline. Cmd/Ctrl+Shift+P opens Commands, Cmd/Ctrl+Shift+E focuses files, and Cmd/Ctrl+S saves a file. Workspace and tab context menus contain management actions. Reviews send feedback to the conversation that requested them; draft comments remain private until submission.

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

- Chats support Codex and Kimi, including images and native-session handoff. Claude remains a product requirement but is not available in the selector.
- Session commands (`/help`, `/status`, `/skills`, `/plugins`, `/config`, `/agents`) inspect native data without sending a prompt. Codex skill selection attaches the native skill to the next prompt. Configuration and plugin changes, and direct child-agent control, remain in the native client. Token usage appears only after provider telemetry; account limits are available only when Codex supplies them.
- Bitwarden is pinned and bundled in packages. Its installed path stays within the Cod profile across package updates. Upgrading from older releases that loaded it directly from a timestamped package may require one final sign-in; their old extension storage is preserved without attempting a partial authentication migration. After the first vault login, reload an already-open page once before autofill. The verified save path is the extension's vault UI; automatic capture of a submitted login is not established. Arbitrary extensions are unsupported.
- Ad blocking uses an existing engine with a per-site toggle. Fixture tests do not establish equivalence to AdGuard on every site. Camera, microphone, location and other page permissions are currently denied with an explanation.
- The optional [status integration](runtime-plugins/cod/README.md) installs hooks only after a profile preview. Native trust and authentication requirements still apply; successful installation is not proof that the provider executed its hooks.
- Terminal processes do not survive quitting Cod. Restored terminals use fresh shells and never replay old commands. Disowned or HUP-resistant jobs are outside ordinary foreground cleanup guarantees.
- Registered HTML artifacts may submit to their originating conversation. General agent browser control, a mailbox and cloud execution are out of scope.
- Recent graphical acceptance used isolated Linux Electron. The current macOS bundle has CLI/PTY checks and a local ad-hoc signature; it is not notarized, and its final GUI and system default-browser action have not been verified on macOS.

## Development

Read [AGENTS.md](AGENTS.md), [the requirements](docs/vision.md) and [implementation contracts](docs/specs/implementation.md).

- `npm run build`: bundle the application and CLI.
- `npm run check`: formatting and TypeScript checks.
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
