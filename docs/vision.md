# Cod: vision and requirements

Product requirements, distinct from the capabilities currently shipped in [README](../README.md). Earlier Zed-fork plans and historical issues are reference material, not additional requirements.

## Vision

Cod is a simple desktop workspace for directing local coding agents and reviewing their work across several tasks.
It brings conversations, repositories, documents, reviews, terminals and everyday browsing into persistent workspaces.
Everything in Cod's own interface works from the keyboard and is controllable through its CLI.
The workspace panel shows which sessions need attention.

Cod is for agent-driven work, including discussing requirements, writing specs, implementing changes and reviewing results.
It includes basic editing for documentation and quick corrections.
Substantial traditional coding belongs in a separate editor.
Cod should also serve as the user's main browser and the place they spend most of their working day.

## Principles

- Simple, opinionated UI with few controls and settings.
- Small codebase, quick builds and modest development disk use. Rust is excluded.
- No full Zed feature or keymap parity requirement. Use familiar compact desktop widgets and closely match the supplied Zed references for geometry, spacing and selection.
- Agterm and Revdiff inspire high-level concepts: workspaces, full CLI control and local review. Their implementations and interfaces are not specifications for Cod.
- Generic building blocks. Task trackers, worktrees, deployments and merge-request workflows belong in agents, skills and scripts.
- Agents must understand their environment. Cod supplies maintained instructions, discoverable CLI help, current context and accurate capability information.
- Local execution only for v1. An unspecified future cloud runner must not drive today's architecture.
- Linux first, macOS second, retained from the existing platform scope.

## Core concepts

- Workspace: a named place with zero or more folders, agent conversations and a saved arrangement of panes. A workspace can span several repositories or contain no repository at all.
- Conversation: a native session belonging to Claude Code, Codex or Kimi Code, presented through the same chat interface.
- Tab/view: an open chat, editable file, document preview, diff, review, browser page, terminal or agent-made HTML page.
- Pane: a tab group within the workspace layout; panes can split, resize, hide or maximize.
- Review: feedback on a document or repository changes, with anchored draft comments submitted together to the originating conversation.
- Browser profile: one shared set of browser logins across workspaces in v1.

A conversation can move to another workspace without becoming a new native session or interrupting its active turn. Its history, composer draft and originating reviews follow it. Workspace membership and the native process working directory are distinct and must be presented honestly.

Users can remove an idle conversation from a workspace without deleting its native provider session or history. Removal clears its workspace row and open chat view; the existing reopen-closed-tab action restores an accidentally removed conversation and its draft. Closing a tab alone keeps the conversation in the workspace. Active work and pending review or form submissions must not be silently abandoned.

A task often corresponds to one workspace, but this is a workflow convention, not a built-in dependency on a tracker.
The expected daily use includes 2-4 parallel tasks plus temporary conversations and browsing.

## v1 requirements

### Workspaces and attention

| ID  | Requirement                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS1 | Create, name, switch and close workspaces containing zero or more folders and multiple repositories.                                                                            |
| WS2 | Workspaces can start empty and gain chats, folders and other panes as needed.                                                                                                   |
| WS3 | A visible workspace/session panel shows session activity and attention states, with workspace-level indications when a session needs attention.                                 |
| WS4 | A shortcut focuses the panel. Arrow keys navigate its workspace and session rows, with keyboard activation. No separate overview or next-needing-attention command is required. |
| WS6 | Restore workspaces as left: pane layouts, open files and pages, saved conversations and the active pane.                                                                        |
| WS9 | CLI consumers can observe relevant workspace, session and review state changes. Transport and event schema are implementation decisions.                                        |

Ship a provider integration plugin with the Cod skill and ready-made status hooks so users do not have to build their own status system. Offer setup in the first conversation for each detected provider profile, with a preview and an explicit install action. Remember dismissal for that profile and keep setup available in Commands. The plugin owns the rules mapping provider events to working, waiting and completion statuses. Users may extend these rules through hooks and scripts.
Cod owns status storage, display and CLI updates, plus technical process and connection state. Do not duplicate the plugin's task-status rules in the application or infer task completion from a disconnected process.
Agents and scripts use the same status and context CLI, including requesting a review. Verify that provider hooks run through the chat adapter as well as the native CLI; if they do not, prove an alternative event delivery path to the plugin before claiming compatibility.
Updating a background session must not steal focus.
Completion acknowledgment and status precedence are defined in the [implementation contracts](specs/implementation.md).
Workspace and conversation rows show status through the color of their existing object icon: neutral, working, needs attention, completed and failed. Do not add a separate status dot, embedded status symbols or user-defined status glyphs. The workspace icon reflects the highest-priority status among its conversations using the existing precedence. Hover text and accessible labels name the state and available context; actionable reasons remain visible in the conversation. Review requests use the needs-attention color while retaining their object identity.

### Agent conversations and CLI

| ID  | Requirement                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Claude Code, Codex and Kimi Code in a proper, simple chat UI, including messages, tool activity and permission requests.                                                                                                                      |
| A2  | Continue the same native conversation in Cod or the provider's CLI without importing or converting it. Handoff is one at a time; simultaneous control is not required.                                                                        |
| A3  | Open existing native provider conversations in Cod. Provider discovery and session-storage compatibility require verification.                                                                                                                |
| A4  | Common actions include starting a conversation, sending a message, interrupting and answering permission requests. Expose provider-specific models and modes where supported, and make unsupported capabilities clear.                        |
| A5  | Full CLI control through codctl: manage workspaces and folders, manage and arrange panes, open files and URLs, start and interact with conversations, show diffs, open agent pages, request reviews and wait for feedback, and inspect state. |
| A6  | Multiple conversations and different providers can coexist in one workspace.                                                                                                                                                                  |
| A8  | Agents and scripts can supply short status context through the CLI.                                                                                                                                                                           |
| A10 | Bundle a skill and discoverable CLI help describing Cod's commands, capabilities and limitations. Supply current workspace/session context and keep instructions aligned with the installed application.                                      |

Use provider adapters behind one common UI and service model.
No general-purpose mailbox or message bus is planned for v1. Opening chats alongside each other and sending prompts through codctl remain required; coordination workflows belong in skills and scripts.
Conversations support image attachments, including clipboard paste, preview before sending and viewing sent images. Preserve attachments with drafts and conversation history. Verify support for each provider and expose unsupported capabilities explicitly.
Use the existing coding agents rather than building a new agent loop around model APIs.
Integration protocols, authentication and native-session continuity must be investigated for all three providers before committing to an adapter design.
A common interface must not silently discard useful provider capabilities.

### Basic editing and Git

| ID  | Requirement                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | View and edit files, including documentation, with syntax highlighting, a file tree and search.                                           |
| C3  | Recognize each Git repository independently within a workspace. Show changed files and changed-line markers using the correct repository. |
| C8  | Open a repository's local changes or branch diff for review. Reviewing repositories one at a time is sufficient.                          |

No requirement to grow into a full IDE.
LSP features, blame, hunk reversion and other advanced editing features from the previous vision are not v1 commitments.

### Local review

| ID  | Requirement                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C4  | Review repository changes locally with anchored comments. A combined cross-repository review is not required.                                                                       |
| C5  | Discuss a spec, plan or document in chat while the agent updates it alongside the conversation. The user can edit it directly or leave comments.                                    |
| C6  | An agent can request a review through codctl, mark it as needing attention and wait for the submitted response.                                                                     |
| C9  | Attach comments to relevant lines or passages of documents and diffs.                                                                                                               |
| C12 | Keep comments as private drafts until the user submits the round together to the originating conversation. Include enough file and repository context for the agent to act on them. |
| C13 | Support repeated review rounds after the agent revises the work. Preserve feedback context without silently attaching comments to unrelated text.                                   |
| C15 | Save open reviews and draft comments across app restarts.                                                                                                                           |
| C16 | Let the user see what changed since the previous document review.                                                                                                                   |
| C17 | Agents can present individual files and documents for review, not only Git diffs.                                                                                                   |

### Browser and previews

| ID  | Requirement                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Browser panes suitable for everyday browsing, with navigation, persistent logins, downloads, uploads and popup handling. Validate representative complex sites.                               |
| W2  | Arrange chats, files, reviews, browser pages and terminals in freely split panes and restore the arrangement.                                                                                 |
| W3  | Agents can open HTML pages through codctl. A small bridge lets registered agent pages submit responses to their originating conversation. Ordinary websites have no access to Cod actions.    |
| W4  | Markdown previews include Mermaid diagrams and highlighted code blocks.                                                                                                                       |
| W5  | Open web links and file references from conversations in the appropriate Cod pane.                                                                                                            |
| W6  | Share one browser profile and its logins across workspaces. Separate profiles are deferred.                                                                                                   |
| W7  | Support the existing Bitwarden extension, including unlock, autofill, password generation and saving logins. Verify persistence across restart.                                               |
| W8  | Built-in ad blocking using an existing engine, with a per-site toggle. It must be comparable to AdGuard on representative daily-use sites, including ads, leftover clutter and page breakage. |

The goal is to replace the user's primary browser, not to promise every Chrome feature.
Bitwarden compatibility does not imply support for arbitrary extensions or an extension store.
Apple Passwords is not a v1 requirement. Cookie importing is not needed.
Agent screenshots and agent browser control are outside v1; opening a URL through codctl remains in scope.

### Terminals, platform and interaction

| ID  | Requirement                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Ordinary interactive terminal panes for shell commands and tools, alongside the proper agent chat UI.                                                   |
| P1  | Linux and macOS support, with Linux first.                                                                                                              |
| P2  | Simple, opinionated interface with few settings.                                                                                                        |
| P3  | All Cod controls work from the keyboard, including chats, reviews, the workspace panel and pane management. Web pages keep their own keyboard behavior. |
| P4  | Clear modules, few dependencies, quick builds and modest development disk use.                                                                          |

The visible workspace panel is the starting navigation model. It lists expandable workspaces with summarized attention status, conversation children and pending review requests beneath their originating conversations. Selecting a conversation or request jumps directly to it, including across workspaces. Tabs still arrange open content within each workspace. Browser notifications may later join this navigation model; notification infrastructure is deferred. Workspace-row context menus provide Rename, Add folder and Close workspace. Repository-root context menus provide removal from the workspace without deleting files. File browsing, quick-open by filename and workspace text search are separate interactions.
Workspace rows have no separate disclosure arrow. Clicking the workspace icon toggles its children; clicking its label selects the workspace. A collapsed row shows a muted conversation count. Preserve manual collapse across restart and ordinary selection/status updates; explicitly navigating to a hidden conversation reveals it.
There is no separate overview dashboard requirement.
A new workspace opens with chat as its main view, with a provider selector in the chat rather than a separate provider-selection step. Existing workspaces reopen as left.
Chat content and input use the available pane width up to a configurable pixel maximum. Keep input at the bottom in both empty and populated chats, without moving it after the first message.
Add folder uses the native directory chooser from workspace and file-tree context menus, including an empty tree. Settings is available from the application menu, command palette and Cmd/Ctrl+,; interface, editor, chat and terminal text sizes persist independently without zooming web pages.

Keyboard navigation uses a shared command catalog for bindings, Commands, tooltips and a searchable Keyboard Shortcuts reference in Commands, Settings and Help. Focus-and-return commands reveal navigation and content areas while preserving the previous caret; Tab reaches local controls, and arrows navigate trees, tabs and review ranges. Platform defaults can be overridden in a local keymap file, with effective shortcuts shown throughout the interface. Pane visibility and tab management remain keyboard-accessible; context-specific bindings preserve website editing, terminal control keys and input-method composition.

Use compact creation controls rather than oversized workspace buttons. Discover shortcuts through tooltips and the command palette rather than permanent instructional labels.
The default working arrangement places documents, reviews and browser pages on the left, and conversations and terminals in a tabbed area on the right. A new workspace shows only chat. Either area can hide or expand without closing its tabs, and restoring it preserves the previous arrangement and state. No bottom terminal dock is part of this default. The workspace panel remains at the far left; file navigation opens when needed.

## Technical direction and feasibility gates

Electron and TypeScript are the implementation foundation. Compatibility must still be verified for each supported provider, platform and extension version.
Use prebuilt Electron binaries rather than compiling Chromium.
The previous Electron code is reference material, not an obligation to reuse its design.

Before claiming the corresponding capability is supported:

1. Prove Bitwarden works in the embedded browser on the target platforms. Test unlock, autofill, generation, saving and restart behavior. Electron has partial extension support; Chromium rendering alone does not prove compatibility.
2. Evaluate an existing ad-blocking engine against the agreed AdGuard comparison on representative sites. Do not claim equivalence from the presence of a library alone.
3. Investigate Claude Code, Codex and Kimi Code together: supported integration protocols, permissions, interruption, status events, authentication and native-session round trips.
4. Reconsider the foundation if these checks require a large compatibility project. Record outcomes before treating them as supported features.

The UI and CLI should use the same application operations so CLI control remains complete.
External pages must remain isolated from local app privileges.
The agent-page bridge is intentionally limited to origin-bound response submission.

## Deferred or excluded

- Zed fork, Zed parity and a full traditional IDE.
- Cloud or remote agent execution and a speculative cloud-runner architecture.
- Agent browser screenshots and browser control.
- General extension support, extension marketplace and Apple Passwords integration.
- Cookie import and separate browser profiles.
- A separate workspace overview, attention switcher or live dashboard.
- Agent and terminal process survival after quitting Cod. Restore saved conversations and layouts, not running processes. Resume support is distinct from process survival.
- Live simultaneous sharing of a conversation between Cod and its provider CLI.
- Chat replies, threads and forks beyond providers' ordinary native conversation behavior.
- Combined cross-repository reviews.
- Hardcoded tracker, worktree, deployment or merge-request workflows.

Desktop notifications, workspace archival and other requirements not carried over above are not automatically v1 commitments.

## Quality and success

Real Electron end-to-end tests verify user-visible requirements, including keyboard paths.
Use invented fixtures and scripted fake providers for routine tests, with targeted live checks for real provider and browser compatibility.
Public artifacts must contain no employer data, credentials or private browsing content.
Tests and screenshots compare against the agreed Cod experience, not Zed.
The team performs QA; the stakeholder gives product and daily-use feedback.

Success means the user can manage several local agent-driven tasks, write and review specs, review repository changes and do everyday browsing inside Cod.
They can spot sessions needing attention in the workspace panel and reach them from the keyboard.
Quick edits do not require leaving Cod; substantial traditional coding can remain in another editor.
Agents understand and use Cod's CLI without repeatedly being taught their environment.

## Research references

These are prior art, not additional requirements or verified compatibility claims:

- [Agterm](https://agterm.com/docs): workspaces, status hooks, CLI discovery and optional process persistence.
- [T3 Code default browser](https://github.com/pingdotgg/t3code/blob/main/docs/user/default-browser.md): external-link routing into an agent workspace.
- [Electron extension support](https://www.electronjs.org/docs/latest/api/extensions): partial Chrome extension support.
- [Electron Chrome Extensions](https://github.com/samuelmaddock/electron-browser-shell/tree/master/packages/electron-chrome-extensions): extension compatibility layer.
- [Ghostery Electron blocker](https://github.com/ghostery/adblocker/tree/master/packages/adblocker-electron): existing ad-blocking engine.

Competitor comparisons from earlier descriptions are not requirements and need fresh verification before publication.

## Interface conventions

Use a fixed, bounded workspace selector centered in the title bar. Workspace and file visibility controls sit on its left, after native window controls; content-area visibility controls sit on its right. There is no persistent footer. The workspace tree provides task/session/attention navigation; the independent file tree browses attached roots. Neither needs a redundant heading or bottom creation shelf. Text search belongs in Commands and its shortcut. Global controls remain in the title bar when a pane is maximized. Transient feedback stays visible without reserving a bottom strip.

Maximizing a pane fills the window's working area below the title bar, temporarily hiding navigation and other panes. Restore recovers the previous panel visibility, widths and split arrangement. Explicitly revealing a navigation panel leaves maximized mode. This is an in-window layout action, not operating-system fullscreen.

Use compact One Dark editor conventions: neutral selection and focus, consistent row/tab sizing, content-sized tabs with bounded width and truncation, and no active-tab underline. Keep keyboard focus visible. Native window chrome follows the platform; websites and Bitwarden keep their own appearance. Secondary actions belong in context menus, shortcuts and Commands rather than persistent buttons or explanatory hints.

Pane visibility controls remain discoverable even before the material area is opened; revealing an empty area does not start another agent. Shared form, menu, tree and tab controls use consistent spacing, focus and interaction across screens. Tool activity is collapsed per turn while pending approvals and actionable errors remain visible.

Provider session commands expose actual native status, skills, plugins, effective configuration and subagents where supported. Unsupported or unavailable sections say so; opening an inspector never sends an inference prompt. Skills retain their native path identity when names collide.

The composer stays at the bottom of empty and populated chats. Enter inserts a newline and Cmd/Ctrl+Enter sends; there is no permanent Send button. Model and reasoning choices use consistent compact keyboard-accessible menus that stay within the window. Do not show an unexplained working-directory basename in the composer; the full session directory remains discoverable in session details. Commands and the composer background context menu provide a mouse path while the text field retains native editing actions. Preserve the next draft during an active turn.

A completed agent turn presents its final answer once, with routine intermediate commentary and tool activity inside a compact expandable activity row. While the turn is running, show its working or waiting status in that same transcript position, including before the first response arrives; do not duplicate it above the composer. Show measured working duration when known rather than repeating the provider name; imported history without timing must not invent a duration. Failed tool calls remain inside completed turn activity; a command failure is not automatically a request for user action. Active progress, questions requiring an answer, permissions and provider failures that block continuation remain visible. Preserve all messages in the expanded activity and keep their order.

Reviews are actions on existing material, not a tab type to create from a generic New menu. Opening a request shows its source alongside its originating conversation without undoing deliberate pane visibility. Comments remain private until one submission; approval without comments is an explicit outcome. Reading a completed reply acknowledges it, but opening a review does not submit it.

Workspace and tab closure is recoverable. Closing a chat view preserves its session; closing a terminal ends its owned shell. Closing active workspace activity requires an explicit stop decision, with Cancel selected by default. Hiding only changes visibility. Saved context can reopen; ended processes never pretend to survive or replay their former commands.
