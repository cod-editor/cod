# Cod

An overbloated mix of code editor, terminal, browser and coding agents. So, a tiny subset of VS Code, essentially.

Mostly, it's a place to give agents work, review what they did, and keep each task's chats, files and web pages together.

- Persistent workspaces, mixed tabs and a searchable Overview.
- Codex and Kimi chats with images, message queues and native CLI handoff.
- Files, Markdown/Mermaid previews, image previews, anchored reviews and real terminals.
- A browser with pinned sites, ad blocking and Bitwarden.

It's an experimental Electron app. Expect rough edges; Claude support is still pending.

## Run

Requires Node.js 24+ and npm. Install and authenticate the agent CLIs you want to use.

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run prepare:bitwarden
npm start
```

Linux needs Electron's system libraries and a graphical session. macOS packages are not notarized.

`npm run codctl -- --help` lists the CLI commands; run Cod before using them.

## More

[Usage, settings and limitations](docs/usage.md) - [Agent instructions](runtime-skills/cod/SKILL.md) - [Testing](tests/README.md).

Working on Cod? Read the [working agreements](AGENTS.md), [vision](docs/vision.md) and [contracts](docs/specs/implementation.md).

[GPL-3.0-or-later](LICENSE). The earlier Zed version is [archived here](https://github.com/cod-editor/cod/tree/legacy-zed-2026-11-10).
