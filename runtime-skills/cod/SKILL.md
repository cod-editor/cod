---
name: cod-runtime
description: Operate the running Cod desktop workspace through codctl. Use when managing Cod workspaces, panes, files, native conversations and supported application controls.
---

# Operate Cod through codctl

Use `codctl --help` (or `npm run codctl -- --help` in a development checkout) for the installed command contract. Commands return one JSON object and nonzero on errors. The Cod app must be running. If `codctl` is not on PATH, app-managed agents and CLI handoffs can run `ELECTRON_RUN_AS_NODE=1 "$COD_NODE_PATH" "$COD_CLI_PATH" --help`; preserve the inherited `COD_SOCKET_PATH` and `COD_DATA_DIR` routing variables. This works from any project directory.

Each app-managed Codex/Kimi controller receives a session-bound MCP server with `cod_context` and `cod_help`. Call these tools to discover the current owning workspace/conversation, actual CLI command, installed help and capabilities. They are read-only; execute the supplied CLI command for supported mutations. Keep explicit target IDs even when another workspace is focused. After moving a conversation, call `cod_context` again: startup `COD_WORKSPACE_ID` is only an initial hint, not current membership. The MCP environment contains only Cod routing values and the Electron Node-mode switch; native model/auth/settings remain provider-owned.

## Current capabilities

- Inspect `state` and `capabilities`. State includes workspaces, pane layout and native conversation records.
- Open, write, resize, inspect and close real local terminals. `terminal write --id ID --data TEXT` sends exact input without an implicit newline. Terminal output is a bounded display cache; use inspect for PID, dimensions and status.
- Open, navigate, inspect and close browser panes; use back, forward and reload. Browser IDs differ from pane IDs. Browser URLs support HTTP/HTTPS and about:blank; external pages never receive Cod IPC. Downloads show status and a local path.
- Create, rename, focus and close workspaces; add folders.
- Open files and split, focus, resize and close panes. List/search only configured workspace folders with project commands. Inspect each Git repository independently; use diff open for local tracked changes or explicit base/head direct-tree comparison. Open sandboxed Markdown previews with preview open.
- file.resolve resolves explicit references only within the owning workspace roots and returns candidates. Do not guess when multiple repositories contain the same relative filename. UI references show a Choose file dialog. Native editing persists drafts separately; file save checks expected-content and never silently overwrites external edits.
- Create or attach native Codex/Kimi conversations, send one turn, interrupt, answer pending permissions and inspect transcript/tool/permission state.

## Native conversation workflow

1. Create a workspace and note its opaque `id` from the JSON result.
2. Run `codctl conversation create --workspace ID --provider codex|kimi --cwd ABSOLUTE_PATH`.
3. Save the returned conversation `id`, `paneId` and `nativeId` as distinct values.
4. Run `codctl conversation send --id ID --text TEXT`. This starts one turn and returns promptly.
5. Use `codctl conversation inspect --id ID` for messages, tool activity, status and pending permissions. Answer an approval only with its current request and offered option IDs.
6. To attach an existing native session, use `conversation resume` with its provider, working directory and native ID. Native history is loaded without sending a prompt. One Cod controller owns a native conversation at a time.

For a first task in a fresh Untitled workspace, prefer renaming the current workspace and adding its folders. Create another workspace only when the user asks for separation or an existing destination should be used. Never automatically close or delete the source workspace.

To relocate yourself, create the destination workspace, attach its folders, then run `conversation move --id CONVERSATION_ID --workspace DESTINATION_ID`. This preserves the same native session, active turn, composer draft and origin reviews. The focused chat follows automatically; use `--follow true` only for intentional navigation. Do not create/resume a duplicate session or close the running controller. Native cwd remains unchanged, including subsequent turns. After relocation reread `cod_context`, inspect destination folders and use absolute destination paths or an explicit tool cwd for repository work; never assume relative paths now target the new workspace.

Use `conversation native-inspect --id ID --section status|skills|plugins|config|agents` for actual native session information. Unsupported sections report their limits. Standalone session commands are not inference prompts. When selecting a native skill, preserve its exact name/path in the optional `skills` JSON argument to `conversation send`; duplicate names require a specific selection.

Explicit background IDs do not change the focused workspace. Closing a conversation tab preserves its native controller and history. Use `conversation show --id ID` to reopen it. `conversation remove --id ID` removes an idle chat from the workspace sidebar without deleting its native session/history; `pane reopen --workspace ID` restores the most recently removed local chat. Stop active work and resolve pending reviews before removal; a CLI-owned session must first return to chat. Closing a workspace with running agents or terminals requires explicit `--force true` after human confirmation that owned work should stop. Quitting Cod stops owned providers; the next explicit send resumes the same native identity without an automatic inference turn.

Terminal records and working directories restore with fresh shells after app restart, without command replay or surviving process claims. Closing a terminal pane or workspace stops ordinary owned foreground jobs; HUP-resistant/disowned processes are not guaranteed contained.

Browser panes share a persistent login session across workspaces, separate from the application session. Restart restores URLs, not submitted form actions. Camera, microphone and location permissions are denied in this checkpoint; built-in ad blocking and the packaged Bitwarden extension are integrated. Their compatibility is bounded by the installed extension/runtime versions. Site-specific compatibility beyond the tested fixtures remains unverified.

## Limitations

Claude and native mode selection are not exposed. Use `conversation options --id ID` to read provider model/reasoning choices, then `conversation option --id ID --option model|reasoning --value NATIVE_VALUE`. Codex overrides apply to the next turn; Kimi reports its native application effect. Never invent model IDs. Codex paginated history is marked partial when older pages are not loaded. Kimi replay reconstructs consecutive text blocks rather than guaranteeing original bubble boundaries. Fixture tests do not establish live account compatibility.

## Local review workflow

Open a document with `review open-document --workspace ID --conversation ORIGIN_CONVERSATION_ID --path PATH`, or one repository diff with `review open-diff --workspace ID --conversation ORIGIN_CONVERSATION_ID --repo-root PATH` (optional paired base/head refs). Save returned reviewId and roundId. Use `review inspect --id ID` for public status. Private draft bodies are deliberately unavailable through CLI, state and MCP. Only the human submits drafts unless they explicitly delegate submission.

`review wait --id ID --round ROUND [--timeout-ms N]` polls durable submission: success returns frozen feedback and delivery status; timeout exits 2 without publishing. Disconnecting does not cancel the review; rerun after restart. Never paste a waiter result back into chat automatically.

Review creation binds the originating conversation. Human submission returns feedback only to that origin; no recipient picker or rerouting is supported. Submission uses a stable request-id. Repeated matching request IDs return the same submission. Busy/stopped destinations keep feedback queued. `review deliver --id ID --round ROUND` delivers definitely unsent queued feedback, or reconciles uncertain delivery using fresh native history. It never blindly resends uncertain feedback. Acknowledgement records native turn completion or a matching native user-history entry. Exactly-once remote delivery across provider failures is not promised. Refresh creates a new immutable round; old unsubmitted comments are marked outdated rather than moved to unrelated lines.

When requesting review from the destination conversation itself, open the review and end the current turn so the human's submission can start the next turn. Do not block that conversation's own turn waiting for its review by default: a busy destination queues feedback. `review wait` is useful for orchestrators and explicit readers; always inspect its delivery status and never blindly paste or resend the result.

Closing a review pane retains its private drafts. Reopen it with `review show --id ID` or the review row in the workspace panel. Workspace closure is rejected while current draft comments or undelivered feedback remain; submit or explicitly delete draft comments and resolve delivery first.

## Tabs, groups and attention

A pane ID identifies a content view (chat, terminal, file, browser or review). A group contains tabs and has an active pane. Workspace `groups` and `groupLayout` describe the actual arrangement; the legacy `layout` is retained for older clients. Use `group split` to create a side-by-side group or move an existing tab with `--pane-id`. Use `pane move --workspace ID --id PANE --group GROUP`, `group zoom`, `group visibility` and `group resize` for arrangement. Hiding or maximizing preserves other groups and running work. `pane close` closes the view; terminal closure ends its owned shell. Material normally opens to the left and chats/terminals to the right, preserving explicit arrangements. `group ensure --workspace ID --side left|right` reveals the area or creates its initial empty view without starting an agent. New workspaces open an empty chat without starting a provider. CLI workspace creation is background by default; explicitly focus only when requested.

`conversation report-status --id ID --status working|waiting|review|ready|failed [--context TEXT]` stores task attention reported by the supplied status hooks or agent. These task states are distinct from technical native connection/turn state. The application does not infer task completion from an idle subprocess. `agent-integration inspect --provider PROVIDER --profile-path PATH` previews exact provider-profile changes. Installing requires that preview hash through `agent-integration install`; inspect preserves unrelated settings and installation creates backups. Do not install or change the human's provider profile without their authorization. The native profile owns hook trust; follow the returned trust instructions rather than changing trust silently.

## Images and agent pages

`conversation send` accepts `--images JSON` containing an array of `{mimeType,data,name?}`, with base64 data and PNG/JPEG/WebP/GIF MIME types. At most eight images totaling 20 MiB are accepted. For large payloads, use `--images-file PATH` containing that JSON array instead of passing it through shell arguments. CLI transport accepts 32 MiB requests and 128 MiB responses. Text may be empty with images. Both native Codex and Kimi receive provider-native image inputs; images are not replaced with textual descriptions.

Use `page open --workspace ID --conversation ORIGIN_ID --path ABSOLUTE_HTML_PATH` to show an agent-created HTML artifact. The page has an isolated origin and a narrow `window.codPage.submit(payload)` bridge bound to that originating conversation. It cannot run arbitrary Cod commands or select another recipient. Treat a successful submission as acknowledgement that a conversation turn was started, not completion of its work. A busy origin rejects submission without dispatch so the user can retry later. Submitted form responses are durably reserved and read-only; completion confirms the native turn finished. A failed or interrupted delivery remains uncertain and cannot be blindly resubmitted, including after restart. Ordinary browser pages do not receive this bridge. Local page reload restores the artifact, never replays submitted form actions.

Closed tab records persist (up to 50 per workspace). `pane reopen --workspace ID` restores the last closed view, including file drafts and native chat identity. A closed terminal process cannot be restored: after human confirmation, `--new-shell true` starts a fresh shell in its previous directory without command replay. Closed workspaces retain archived contexts; `workspace reopen [--id ID]` restores one, with fresh terminal shells and lazy native-session resume. It refuses to restore a native conversation already controlled elsewhere. Browser operating-system URL events open in the active workspace, creating Browsing when needed; this does not imply Cod is registered as the system's default browser.

## Native session discovery and CLI handoff

`conversation discover --workspace ID --provider codex|kimi [--cwd PATH]` lists provider-owned native sessions without importing them or sending an inference turn. Resume with its returned native ID and cwd using `conversation resume`.

`conversation handoff --id ID` requires an idle conversation without pending approvals. It releases Cod's chat controller and opens the provider's ordinary native resume CLI in an owned terminal. The native session ID stays unchanged. While `handoffTerminalId` is set, chat sends and option changes are rejected. Exit the native CLI or close its terminal, then explicitly run `conversation reclaim --id ID` to load native history and return to chat without sending a prompt. Reclaim refuses while the owned CLI process is running. App restart never replays the CLI launch; the old terminal is marked ended and reclaim remains explicit. This ownership guarantee covers the CLI process launched by Cod; do not simultaneously open that session in another external client.

`browser default-status` reports packaged eligibility and the operating system's current HTTP/HTTPS default-handler state. `browser register-default` is an explicit user action supported only by the packaged application; it may invoke operating system confirmation and its returned current state must be checked. It is not run automatically. macOS default-browser interaction requires separate platform verification and is not established by headless Electron tests.
