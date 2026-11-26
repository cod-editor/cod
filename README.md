# Cod

An overbloated mix of code editor, terminal, browser and coding agents. So, a tiny subset of VS Code, essentially.

## Install on macOS

Download the Apple Silicon disk image from [Releases](https://github.com/cod-editor/cod/releases). To verify it, compare the downloaded file’s SHA-256 checksum with the one GitHub displays beside the DMG. Open the disk image and drag Cod to Applications.

Cod uses an ad-hoc signature and has no Apple notarization. If macOS blocks the first launch after you verify the download, follow [Apple's instructions for opening a trusted app](https://support.apple.com/en-us/102445#openanyway).

When Cod offers an update, click **Download**, quit Cod, then replace the app in Applications from the new disk image. Workspaces and settings are stored separately.

## Run from source

Use Node.js 24+ and npm. Install and sign in to Codex or Kimi in its own CLI.

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run prepare:bitwarden
npm start
```

Bitwarden setup is optional. Linux needs Electron's system libraries and a graphical session.

## Use

- **Overview** in the title bar finds workspaces and tabs. The pane's **+** opens files, browser tabs, chats or terminals.
- **Commands** finds actions such as Quick Terminal, Settings and Keyboard shortcuts. Enter sends a chat message. Shift+Enter adds a newline.
- Enable **Run new sessions detached** in Settings to keep eligible local agents running when you quit. A connected Linux workspace continues running on its host.
- For Linux workspaces, install dependencies on the Linux host, then run `npm run build` and `node scripts/install-workspace-host.mjs`. Use **Connect to Linux workspace** with an existing SSH alias. The installer needs a persistent systemd user manager. The host needs authenticated Codex.
- Browser **Home** shows pinned sites. When Google is selected, Cod can send plain search text as you type to fetch suggestions. Inferred HTTPS can offer a one-time **Open over HTTP** choice.
- While Cod runs, use `npm run codctl -- --help` for automation.

[Working on Cod](AGENTS.md) · [GPL-3.0-or-later](LICENSE)
