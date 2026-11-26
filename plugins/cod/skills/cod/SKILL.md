---
name: cod
description: Operate the running Cod workspace through codctl, including files, tabs, terminals, native chats and reviews.
---

# Operate Cod

Use `codctl --help` and `codctl capabilities` for the installed commands. Use `npm run codctl -- --help` in a development checkout. App-managed agents can use `ELECTRON_RUN_AS_NODE=1 "$COD_NODE_PATH" "$COD_CLI_PATH" --help` if `codctl` is absent. Preserve inherited routing variables `COD_SOCKET_PATH` and `COD_DATA_DIR`.

Run `codctl context` for the owning conversation, workspace, folders and location. Outside a managed chat add `--conversation ID`. Use explicit IDs for all actions. Workspace, pane, native session, browser and terminal IDs identify different objects. Use scoped inspection before reading a full state or transcript.

## Workspaces and material

- For a fresh Untitled workspace, reuse it unless the user requests separation. Add only the requested folders. `workspace prepare --name NAME` follows the configured default host. Pass `--location local|linux` for an explicit override and `--folders` with a JSON array of absolute paths on that host. Use the returned workspace ID. On a lost response, retry the same name and folders on the same host.
- Connect to a prepared Linux host with `workspace connect --alias HOST` using an existing SSH alias. Reconnect with `workspace reconnect`. Browser views and the browser profile stay on the desktop. Check host service health with `systemctl --user status cod-workspace-host`. Reinstall stages a release. Restarting the service ends its owned jobs.
- Private remote review and approvals require explicit pairing. The host profile's owner-writable `desktop-signers` file uses OpenSSH allowed-signers format, for example `cod-desktop namespaces="cod-review" ssh-ed25519 YOUR_PUBLIC_KEY`. The user selects the matching `.pub` in desktop Connection options.
- Move your existing chat with `conversation move --id ID --workspace ID` on the same host, or use `workspace prepare --conversation ID` for same-host preparation. Run `context` again afterward. The native cwd and controller stay the same. Use `conversation transfer --id ID --workspace ID --cwd PATH` to move an eligible Codex session to Linux. Inspect an uncertain transfer before retrying.
- Show material beside the user with `file open` or `browser open` and `--workspace ID --beside-conversation ID`. Add `--focus true` only for deliberate navigation. PDFs and images can use `file open`; use a `file://` URL for rendered HTML. Resolve relative files in the owning workspace and resolve ambiguity before opening.
- For a failed inferred HTTPS load, `browser inspect` can expose a one-use `httpFallback` offer. Use `browser http-fallback --id ID --offer OFFER_ID` only when the user chooses to visit over HTTP.
- Use `pane reopen` for a recently closed tab. Moving a tab keeps its identity. Closing a terminal ends its owned shell. Reopening with `--new-shell true` starts a fresh shell, with no command replay. Closing a workspace with live work requires explicit consent before forcing it.

## Chats and terminals

- Inspect with `conversation inspect --id ID` or use `conversation native-inspect` for provider metadata. Use `conversation options` for available model and reasoning values, and leave authentication to the native provider.
- Use `conversation create --workspace ID --provider codex|claude|kimi --cwd PATH` for a new chat. Discover an existing session with `conversation discover` and resume it with its native ID and cwd. Opening a saved chat sends no message. Keep a single controller per native session.
- `conversation send --id ID --text TEXT` submits one turn. Images use `--images-file` with a JSON array of `{mimeType,data,name?}` and base64 data, up to eight and 20 MiB total. Check native history before retrying a send or tool result whose delivery is uncertain.
- Handoff requires an idle chat. `conversation handoff` gives the native CLI ownership in an owned terminal. Exit that CLI before `conversation reclaim`. A completed handoff is never proof that a new prompt ran.
- `terminal write --id ID --data TEXT` sends the supplied text without an implicit newline. Inspect the terminal for status and bounded output. Detached chat agents and Linux-owned processes have a separate lifetime from desktop terminal tabs.

## Reviews and responses

- For comments on an existing document or diff, use `review open-document` or `review open-diff` with the workspace and originating conversation. Keep the review and round IDs and verify the returned pane. For an ordinary request to view a file, use a preview.
- Human submission targets the bound conversation. Draft comments stay private. When requesting review from the same chat, end the turn so the submitted feedback can start the next one. An orchestrator can use `review wait`; cancellation and timeout send nothing. Use `review deliver` to check or deliver queued feedback, never resend an uncertain submission blindly.
- For an HTML form that submits to the originating chat, use `page open --workspace ID --conversation ID --path ABSOLUTE_PATH`. Opening the same file for the same workspace and conversation shows the existing tab and preserves unsent input. Add `--refresh true` after editing the HTML to reload the existing tab, which resets unsent input. Its `window.codPage.submit(payload)` bridge is origin-bound. Acceptance starts a turn and does not prove completion. Ordinary HTML and websites have no bridge.
- For a Codex tool result use `conversation send-tool-result --id ID --name NAME --output TEXT`. An accepted receipt identifies a native turn. Check history before retrying an uncertain receipt.
- Task attention is set using `conversation report-status`. Native turn state is separate. `agent-integration inspect` previews profile changes. Install only with human authorization and the returned preview hash. Hook trust is granted by the user in the native client.
