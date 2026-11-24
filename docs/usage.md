# Using Cod

Setup, daily use and current limits. Start with the [README](../README.md) for the short version.

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

A new workspace starts with a chat. Enter sends; Shift+Enter inserts a newline. Cmd/Ctrl+Enter also sends. Cmd/Ctrl+Shift+P opens Commands, Cmd/Ctrl+Shift+E focuses files, and Cmd/Ctrl+S saves a file. Sending during a Codex response adds the message to the current turn when supported. Kimi ACP and Codex controllers without steering support show the message in the existing queue. Workspace and tab context menus contain management actions. Reviews send feedback to the conversation that requested them; draft comments remain private until submission.

Use the workspace title, Commands > Overview or Cmd/Ctrl+Shift+O to search workspaces, conversations, browser pages, terminals and pending reviews. Arrows select and Enter opens the selected result. Cmd/Ctrl+Enter renames a selected workspace or chat. The Close Tab shortcut closes a selected unpinned tab and leaves Overview open. Right-click or Shift+F10 opens its actions. Use Files or Open file to browse repository material. Escape returns to the previous control or native page.

Remove from workspace in a session's context menu clears it from the workspace without deleting its native history. Reopen closed tab restores the removed chat and draft; the native session remains available in the provider's CLI. Stop active work and finish pending reviews or form submissions before removing the session.

Keyboard shortcuts is searchable from Commands, Settings and the Help menu. Focus files / return reveals Files and returns to the previous control on a second press. Use Overview or tab and pane navigation to reach a chat or terminal. Tab moves through local controls. Trees and tab bars use arrow keys, and Shift+F10 opens context actions. The reference shows platform defaults and their contexts: web editing and terminal control keys stay with the page or shell, while Find in current content searches the active editor, conversation, terminal or embedded page. Open keyboard shortcuts file from Commands or the reference to edit `keymap.json` in Cod's data directory. Map command IDs to shortcut arrays (for example, `"focus.files": ["Alt+E"]`) or `null` to disable a binding. `Mod` means Command on macOS and Control elsewhere. Changes reload automatically; an invalid file falls back to defaults and shows its error in the reference.

While Cod runs:

```sh
npm run codctl -- --help
npm run codctl -- workspace create --name "Documentation"
npm run codctl -- workspace add-folder --id WORKSPACE_ID --path /path/to/repository
npm run codctl -- file open --workspace WORKSPACE_ID --path /path/to/spec.md
npm run codctl -- state
```

CLI creation stays in the background unless focus is explicitly requested. Set `COD_DATA_DIR` and `COD_SOCKET_PATH` for a separate application instance. Instructions for agents using Cod are in [plugins/cod/skills/cod/SKILL.md](../plugins/cod/skills/cod/SKILL.md).

## Features and limits

Overview lists conversations and browser tabs. A pane's `+` opens Open file / Browser / Chat / Terminal choices. New tab (`Cmd/Ctrl+T` or a double-click in free tab-bar space) creates a fresh tab of the current kind: a blank browser, empty chat with the same provider/model, fresh shell in the terminal's current directory, or untitled text buffer. Reviews and empty panes offer the four-choice tab instead. The source content is never copied. Direct creation commands remain available. Drag tabs to the insertion marker to reorder or move between panes; context menus provide keyboard alternatives. Tabs and their order survive restart.

Closing the last tab on either side of a visible split collapses that side. Reopen closed tab restores the tab to its original side and brings back the split at its previous width.

Very high line-count text can stall the native editor during insertion; this is tracked in [#187](https://github.com/cod-editor/cod/issues/187).

Untitled buffers keep unsaved text through closing and restart; Reopen closed tab restores them. Save (`Cmd/Ctrl+S`) opens the native Save As chooser until a path is chosen. Commands > New file creates an untitled buffer directly. From the CLI, `pane new --workspace WORKSPACE_ID --same-as PANE_ID` creates the current kind in the source pane without changing foreground selection; add `--focus true` to select it. `file new` and `file save-as` expose the same buffer and destination operations; see `codctl --help` for arguments.

PNG, JPEG, GIF and WebP files open in Cod's image preview, with fit-to-pane, actual size, zoom and scrolling. Focus the preview and use `0` to fit, `1` for actual size and `+` / `-` to zoom; the same actions are in its context menu. Images are limited to 20 MiB. Explicit absolute file links can open files outside workspace folders, including Downloads; relative references are resolved inside workspace folders. Automatic inline image loading stays limited to workspace files.

Opening a file or web link from a desktop chat shows it in the pane beside that conversation. Choose Open link in its menu for the same placement, or Open in system browser for a web URL. From the CLI, use `file open` or `browser open` with `--beside-conversation ID` to open material beside an originating chat while preserving current focus. Add `--focus true` if requested.

Right-click a web link in chat, Markdown preview or a source file to open it in Cod or in the system browser. Commands > Open in system browser also opens the current web page or the link at the source caret; both actions can be assigned a shortcut in Keyboard shortcuts. Native page link menus offer Open link in new tab, which keeps the source active and adds a background tab at the end of its group. System-browser handoff supports HTTP/HTTPS and reports an error if Cod itself is the system default, to avoid reopening the link in Cod.

New browser tabs show pinned sites shared across workspaces. Use the `+` tile to add a site, its context menu to rename or unpin it, or Commands > Pin current site to home. The address field accepts website addresses without a scheme and searches ordinary text with Google. Ordinary new-tab links stay in workspace tabs and preserve native opener/form behavior; explicit popups remain separate windows. Closed and restarted tabs retain up to 50 URL/title navigation entries. Form contents and POST payloads are not restored. There is no recent-sites section or bookmarks bar. Address suggestions use local history and pinned sites without sending typed text to a server. Commands > Browsing history searches and clears history; a result's context menu removes that entry. Browser settings selects Google, DuckDuckGo, Bing or Yandex. Optional bookmarks are available through Commands > Bookmark current page and Bookmarks (search, edit and remove). They also appear in address suggestions, but add no permanent panel and do not change home pins.

Cod tries HTTPS for addresses without a scheme. A connection refusal or TLS protocol error can offer **Open over HTTP** for one navigation. Cod shows the HTTP origin before opening it and marks the loaded page **Not secure**. An explicit HTTP URL opens directly, and certificate errors keep their usual failure behavior.

- Chats support Codex and Kimi, including images and native-session handoff. Sending while busy can steer an active Codex turn. CLI send and desktop providers without steering queue the message. Waiting messages can be edited or cancelled above the composer. Queues survive restart and then require explicit continuation. Attached Codex chats display externally queued turns from `codex queue --thread NATIVE_SESSION_ID --message TEXT`, including replies and completion status. Background command exit alone does not enqueue a continuation. Kimi currently reports some native failures as an empty successful ACP completion; Cod reports a missing response instead, but the precise cause may require the Kimi CLI or its native log. Claude remains a product requirement but is not available in the selector.
- Session commands (`/help`, `/status`, `/skills`, `/plugins`, `/config`, `/agents`) inspect native data without sending a prompt. Codex skill selection attaches the native skill to the next prompt. Configuration and plugin changes, and direct child-agent control, remain in the native client. Token usage appears only after provider telemetry; account limits are available only when Codex supplies them.
- Bitwarden is pinned and bundled in packages. Its installed path stays within the Cod profile across package updates. Upgrading from older releases that loaded it directly from a timestamped package may require one final sign-in; their old extension storage is preserved without attempting a partial authentication migration. After the first vault login, reload an already-open page once before autofill. The verified save path is the extension's vault UI; automatic capture of a submitted login is not established. Extension authentication windows close independently of Cod; end-to-end passkey authentication is not yet verified. Arbitrary extensions are unsupported.
- Ad blocking uses an existing engine with a per-site toggle. Fixture tests do not establish equivalence to AdGuard on every site. Camera, microphone, location, notification, clipboard, fullscreen and pointer-lock requests require an explicit per-site decision. Choose Allow once, Always allow or Block; use Site permissions in Commands or the site-protection menu to revoke remembered access. OS-level permission can still be required. Screen sharing and device selectors for USB/Bluetooth are not implemented.
- The optional [status integration](../plugins/cod/README.md) installs hooks only after a profile preview. Native trust and authentication requirements still apply; successful installation is not proof that the provider executed its hooks.
- Terminal processes do not survive quitting Cod. Restored terminals use fresh shells and never replay old commands. Disowned or HUP-resistant jobs are outside ordinary foreground cleanup guarantees.
- Registered HTML artifacts may submit to their originating conversation. General agent browser control, a mailbox and cloud execution are out of scope.
- Recent graphical acceptance used isolated Linux Electron. The current macOS bundle has CLI/PTY checks and a local ad-hoc signature; it is not notarized, and its final GUI and system default-browser action have not been verified on macOS.

Downloads are available in Commands and from the browser toolbar once a file has been downloaded. Pause, resume, cancel, retry, open and reveal files there. Closing a tab keeps its download running. Download history survives restart; interrupted transfers require an explicit retry. Removing an entry does not delete the file.

Pin important views through the tab context menu or Commands > Toggle pin tab. Pinned tabs stay first, replace their close button with an unpin icon and survive ordinary or bulk closure. Explicit Close tab in the context menu still closes them; Reopen closed tab restores their pin. Moves and restart retain pins. Optional shortcuts use the existing keymap settings.

Manual Developer Tools are available with F12 or Commands > Toggle Developer Tools. The inspector follows the focused surface: Cod UI controls/chat/files inspect Cod, native page content inspects that exact page. Ordinary browser context menus also offer Inspect element. The alternate shortcut is Command+Option+I on macOS and Ctrl+Shift+I on Linux; optional overrides use the shared keymap. Close the detached inspector with its native controls, or toggle it again from the inspected surface.

## Linux workspace host

Set up the host once from a checked Cod source checkout on Linux. It needs Node.js 22 or newer, npm, and a systemd user manager with lingering already enabled for that account. The installer reports missing prerequisites and leaves account settings alone.

```sh
npm ci --ignore-scripts
npm run build
node scripts/install-workspace-host.mjs
```

The user service owns its private profile at `~/.local/state/cod-host` and runs without a desktop attached. Repeating setup stages the checked host release without restarting an active service. The new release takes effect at the next service start. Check the service with `systemctl --user status cod-workspace-host`. Restart it explicitly only when its owned terminals and agents can end. Install and authorize Codex on Linux with its own account and configuration before starting agent work.

On the Mac, run **Connect to Linux workspace** from Commands and enter the existing OpenSSH alias. Cod uses the verified host key, non-interactive SSH authentication, and the host's installed endpoint command. The host's workspaces appear in Overview alongside local workspaces. You can also connect from any workspace with `codctl workspace connect --alias HOST`, then use `codctl workspace prepare --name NAME --location linux` to open a Linux task workspace.

From the connected workspace, you can open and edit existing text files, use terminals, and work in Codex chats. A lost connection is marked in the workspace title. Use **Reconnect to Linux workspace** or `codctl workspace reconnect` to see the host state and terminal output, including after restarting the desktop. Disconnecting or quitting the desktop leaves Linux work running. A separately managed host may supply an explicit socket via **Connection options** or `--socket-path`. To operate directly on Linux, point `COD_SOCKET_PATH` at the host profile's `cod.sock`.

Browser tabs, cookies and device permissions stay on the desktop. Use the Linux host's CLI to add folders and save a new file to a Linux path. File previews remain local in this checkpoint.

### Default task host

Open **Settings**, search for **Default task host**, and choose **Local** or **Linux**. New setups start with **Local**. This setting applies to `codctl workspace prepare --name NAME` from the desktop, even when a workspace on the other host is selected. Choose **Linux** to use the existing connection or the last successfully connected Linux profile. If the target is unreachable or missing, the command reports the problem. Pass `--location local` or `--location linux` to choose a host for one desktop request. Direct preparation on the Linux host always stays there. Ctrl+N opens a chat in the current workspace.

### Pair review and approvals

On the Linux host, add your chosen existing SSH public key to the private profile's `desktop-signers` file with an entry in the OpenSSH allowed-signers format:

```text
cod-desktop namespaces="cod-review" ssh-ed25519 YOUR_PUBLIC_KEY
```

Use the full type and key data from your local public key file and keep the signer file writable only by its owner. In **Connect to Linux workspace**, expand **Connection options** and enter the matching absolute `.pub` path in **SSH public key for private review**. OpenSSH must be available on both machines and the matching private key must be usable on the desktop, for example through the local SSH agent.

A paired connection can annotate a remote review, respond to Codex approvals and steer an active Codex turn using ordinary send. A missing or rejected key leaves ordinary chat, files and terminals available. Removing a signer blocks the next private operation. Run **Reconnect to Linux workspace** with the same authorized key to resume review. The host-owner CLI retains its existing approval and review commands. The desktop remembers the entered host alias and paths for its next connection. The private key remains on the desktop, and pairings do not change SSH server configuration.

## Development

Read [AGENTS.md](../AGENTS.md), [the requirements](vision.md) and [implementation contracts](specs/implementation.md).

- `npm run build`: bundle the application and CLI.
- `npm run check`: formatting and TypeScript checks.
- `npm run test:unit`: unit and CLI protocol checks; run `npm run build` first.
- `npm run test:providers`: provider subprocess tests, without live accounts.
- `npm run test:integration`: status-plugin tests using temporary profiles.
- `npm run test:isolated`: real Electron acceptance in Docker/Xvfb. It requires the configured Linux test image; see [test environments](../tests/README.md).
- `npm run test:e2e`: the same selected application tests on the current graphical display. Do not run these on somebody's active desktop.
- `npm run format`: format supported source files.

On macOS, prefix long jobs with `caffeinate -dimsu`. Native provider and official extension compatibility checks are separate from deterministic fixture tests.

## Package locally

Run `npm run build`, then `node scripts/package.mjs`. The package is written to `release/cod-PLATFORM-ARCH-TIMESTAMP/`, with the application, a `codctl` launcher and input hashes. It includes the pinned Bitwarden extension and Cod integration, but no provider credentials or development dependencies. Packaging uses the host platform's Electron and PTY prebuilds; cross-copying dependencies between macOS and Linux is unsupported.

On macOS the script signs the bundle ad hoc. `node tests/support/electron/check-package.mjs release/PACKAGE_DIRECTORY` checks its signature, CLI, native PTY and included assets without opening a window. This does not replace isolated graphical release testing or notarization.

## License

Copyright (C) 2026 Mikhail Butvin. GNU GPL version 3 or later; see [LICENSE](../LICENSE). Versions preceding the license change were released under the MIT License.

## Developer delivery status

Run `npm run --silent delivery:status` to compare the latest checked GitHub merge, local HEAD/dirty state, completed dist build and the entry build captured by the running Cod process. It reports fetch/build/restart guidance but performs none of these actions. `--offline` skips GitHub, `--json` gives sanitized machine output, and `--repo PATH` / `--dist PATH` select another checkout/build. The bounded read-only capabilities probe uses the selected build's existing CLI and its normal profile environment; `--socket PATH` overrides `COD_SOCKET_PATH` explicitly. No state/history dump or profile scan is used.

UNKNOWN means evidence is unavailable, not that an update is already running. Legacy builds and already running older versions have no identity and cannot be reconstructed from current dist timestamps. New successful builds carry `build-info.json`; packaging retains it. A running process keeps its startup identity even if those files are rebuilt. Source fingerprints cover declared bundled source, build/config/lock and asset inputs; installed dependencies, external plugins and user state are not certified. No paths, remote names, raw command errors or application content appear in default output. GitHub access is read-only and optional; it requires the existing authenticated `gh` client and never installs or configures it.

## Local diagnostics

Cod writes a local rotating journal under `diagnostics/` in its data directory (`~/Library/Application Support/Cod/diagnostics` on macOS). `runtime.jsonl` and up to three rotated files contain startup/shutdown, renderer and child-process exits, responsiveness events, and memory samples every 30 seconds. The journal is limited to about 4 MiB. Samples include Electron process memory (in KiB), main-process Node memory (in bytes), and available system memory. Samples map renderer PIDs and WebContents IDs to opaque browser-tab and workspace IDs, including registered pages and browser popups. Renderer failure events retain the last known PID so they can be correlated with earlier samples. Several views can share a renderer process; the main application renderer hosts multiple workspaces and is identified as application-wide. Separate provider CLI processes are not included. Chat text, file contents, URLs and arbitrary error messages are not recorded. Nothing is uploaded. Close-tab diagnostics record only the close chord modifiers, the recognized command and the operation outcome/timing; they do not record ordinary keystrokes or message text.

An unfinished session is reported at the next startup; this alone does not distinguish a crash, force quit or system shutdown. A sudden OS kill may leave only the last periodic sample. Restart Cod after updating to enable diagnostics; older runs cannot be reconstructed.

## Settings

Open Settings from Commands or the platform settings shortcut. Search by area or setting name. Appearance changes apply to open views and persist in `settings.json` beside the data file; Edit settings.json opens it in your system editor. Keyboard shortcuts opens the searchable reference and existing `keymap.json`. The browser search engine is searchable in the same window and stays in the browser profile library; Browser settings in Commands opens that section. Workspace-specific chat width takes precedence over the global width.

Settings groups controls by area and hides empty sections while searching. Font choices include System default and generic families; Custom accepts an exact installed font name or CSS font-family list. Numeric values retain direct entry alongside minus/plus controls and nearby reset. Font sizes are in pixels; line heights are multipliers. Terminal settings include block/bar/underline cursor, blinking and scrollback. Editor settings include tab display width and long-line wrapping; tab width does not rewrite file indentation. The source editor uses the platform text caret; changing its shape is not supported. Settings currently cover these implemented controls, not the full extension, theme and language configuration surface of VS Code or Zed.

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

## macOS preview releases

Apple Silicon preview tags of the form `vX.Y.Z-preview.N` publish a versioned DMG from a checked commit on `master`. The macOS workflow verifies the image and tests the copied app's signature, bundled assets, CLI and PTY before publishing. A manual workflow run builds the same artifact without publishing a release. Preview builds use an ad-hoc signature.

When a newer preview is available, Download in the title bar opens the GitHub DMG in your browser. Open the downloaded DMG and drag Cod into its Applications shortcut.
