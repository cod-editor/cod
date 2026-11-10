# Implementation contracts

[The vision](../vision.md) defines product scope. This document records the shared behavior that UI, CLI, persistence and tests must preserve. Supported features and current limitations belong in the root README; test-run histories stay local.

## Architecture and trust

Electron main owns application operations, persistence, files/Git, native provider controllers, PTYs and browser lifecycle. The renderer calls a typed, narrow bridge. `codctl` uses the same operations over a user-local socket; it has no separate business rules. The command catalog supplies CLI help and capability discovery.

External websites never receive Node.js or privileged Cod APIs. Markdown previews and registered agent pages have separate restricted protocols. The registered page bridge validates its server-bound origin, frame and payload; a page cannot choose another conversation. Downloaded files never execute automatically.

Use provider-native protocols and session identity, not a replacement agent loop. Capabilities must distinguish unsupported controls, missing installation, missing authentication and actual failure. At most one controller owns a native conversation. Opening, inspecting or discovering an existing session does not send a prompt.

Provider inspection is read-only and reports native capabilities rather than inventing equivalent controls. Standalone session commands such as `/skills` open inspection instead of becoming prompts. A selected skill carries its exact native name and path; ambiguous names require selection instead of dispatching several skills.

## Identity, layout and focus

- A workspace owns folders, conversations, saved material and a split tree. A pane group holds tabs; a tab refers to content. Moving or splitting a tab must not create another native controller.
- New chat remains available with no open workspaces: create a fresh unnamed workspace and empty composer without restoring closed tasks or starting inference. Reuse a pristine empty composer for this global action.
- New workspaces begin with a chat. Material opens to the left and chats/terminals to the right by default; explicit moves allow mixed tab types and nested horizontal/vertical splits.
- Both default area toggles remain available before the material area exists. Revealing it creates an empty view, not a native conversation; opening material replaces that placeholder. At least one group stays visible.
- Hiding and maximizing change visibility, preserving tabs and saved ratios. Restore returns the previous arrangement. Navigation widths persist and clamp to the current window without overwriting the preferred width.
- Every operation accepts an explicit stable target. Agent-origin creation defaults to background. Status updates, slow navigation and streaming must not steal workspace selection, pane focus, caret or scroll.
- Explicit navigation may focus its content. Dismissing a picker restores the preceding focus and selection. Streaming follows the end only when the reader was already there.
- Successful CLI requests mean accepted operations, not finished inference. Errors leave state unchanged or expose a recoverable partial outcome; never silently discard drafts.

`conversation.move` relocates the existing conversation and its origin-bound reviews without closing its controller or restarting an active turn. Composer text, images and selected skills follow; unrelated tabs stay put. A pristine destination chat placeholder is removed, while populated drafts remain. The focused conversation follows by default; background transfers preserve unrelated focus unless explicitly requested. Native cwd does not change: returned state and inspection retain the actual directory, and agents must use explicit destination paths or tool cwd. Session-bound context resolves current membership on every call rather than trusting startup workspace environment variables. Review sources retain their original authorized roots across relocation.

## Persistence and lifecycle

Persist layout, resource IDs, open views, composer text/images/provider/selected skills, native-session references, file drafts, review drafts and close/reopen history. Restore records without replaying commands, inference or arbitrary website form submissions.

Closing a chat tab removes the view, not its conversation or active turn. Closing a terminal stops its owned shell; reopening requires an explicit fresh-shell action. Closing a busy workspace identifies the work that will stop and defaults to Cancel; CLI callers must explicitly request forced closure. Failed stop or mutation retains usable context. Externally owned CLI sessions are not silently seized or killed.

Native handoff releases Cod's controller before starting the provider CLI. Reclaim checks ownership and resumes the same identity/history without an implicit prompt. Transaction rollback must not resurrect stale process, completion or terminal state.

Command names, shortcuts and surface scopes come from one shared registry used by the renderer and native views. A physical key dispatches once; repeated destructive commands are consumed without repetition. IME and AltGraph input stay with the focused control. Non-Latin letter layouts use physical key fallback while Latin layouts retain logical shortcuts. Websites keep their editing/printing/search keys, and terminals retain shell control keys; the command palette and F6 still reach Cod navigation. Restoring focus to a native page must restore actual input focus, not only active styling.

Use shared desktop field, menu, tree and tab conventions. Collapse historical tool activity per turn without hiding pending approvals or actionable failures.

## Attention and plugin ownership

The provider plugin owns task-status policy. Cod owns technical connection state, status storage, CLI reporting and presentation. A failed process or pending permission cannot be hidden by a stale plugin-ready report. Pending review remains visible until submitted, and hook lifecycle reports cannot overwrite explicit review status.

Technical `ready` means idle; it is not itself a new notification. A successful native completion advances a revision. Explicit chat activation or acknowledgment marks that revision read; a later completion becomes visible again. Options discovery, resume and cancelled turns do not create new completion attention. Completion and acknowledgment revisions persist through restart. Workspace and child rows use the same status meaning and marker.

Plugin installation previews an explicit provider profile, preserves unrelated configuration, backs up modifications and rejects edited managed files or changed preview inputs. It never bypasses native trust, changes authentication or installs silently at startup.

## Files and repositories

File browsing, filename quick-open and content search are separate interactions. Results include repository/path/line identity. Multiple repositories may contain the same relative filename; status, changed lines and diffs must use the correct repository. Branch comparisons compare the two explicitly requested trees, without an implicit merge base.

All views of a file share its current draft. Saving during newer input must not lose that input. External changes, deletion, rename, symlinks and collisions preserve the unsaved version and offer explicit recovery rather than silently replacing data. Tree refresh must find externally created and committed files even when Git is clean, without losing focus.

## Reviews and registered responses

A review binds its source, repository and originating conversation. The user can comment or edit while discussing the document alongside it. Comments remain private until one explicit round submission; an empty round may submit an approval. There is no recipient selector or fallback destination.

Freeze submitted text, anchors, source revision and destination. Sent rounds are immutable. Changed or ambiguous anchors become outdated and require explicit reattachment; refreshing a review never silently attaches feedback to unrelated text. Show changes between review revisions. Persist unfinished comment editors and saved comments separately from delivery.

Delivery distinguishes private, queued, sending, acknowledged and uncertain states. A stable packet identity prevents duplicate delivery. An interrupted dispatch must reconcile native history before retry; an immediate send return is not a remote receipt. `review wait` completes on durable submission, not on completion of the agent's next turn. A waiter may reconnect using the review ID.

A registered form response has the same origin and durable admission protection. Reserve the submission before dispatch, reject duplicates, and restore interrupted sending as uncertain. Keep submitted or uncertain forms read-only. A definitely unsent failure remains explainable and retryable; never silently send to another conversation.

## Browser and terminals

Browser tabs retain independent history/address state and share one persistent profile. Site blocking preferences and downloads survive tab closure. External user links open a new tab without replacing existing work. Authentication popups retain their opener relationship. A failed navigation keeps its last successfully committed web page available through an explicit recovery action. Reload retries the failed address; reopening or restarting a failed tab restores its error state without automatically requesting the failed address again. Native browser/agent-page focus must route close, address and command shortcuts to the correct view.

Host the real Bitwarden UI. Cod owns placement, active-tab binding and load/retry errors; the extension owns vault interaction. Never infer successful autofill from popup loading. Filter cache identity includes lists and resources; failed updates can retain a verified cache only with an honest visible state.

Terminals are real PTYs with explicit cwd, byte-preserving input and resize. Hiding keeps them running while Cod is open. Ended shells retain useful output/context, but no restart action replays their former command.

## Acceptance boundaries

Exercise complete journeys with real Electron, temporary files, real Git and real PTYs: create/switch tasks, discuss/edit/review a spec, implement across two repositories, interrupt work, return later, close/reopen and restart. Include mouse and keyboard paths, native embedded-view shortcuts, concurrent changes, failures and recovery. Inspect screenshots at normal and wide window sizes; passing assertions alone does not establish coherent design.

Scripted provider subprocesses verify deterministic protocol and UI behavior. Separately verify live identity/history round trips, permissions, interruption, images and plugin execution for each supported provider. Credential or platform gaps are BLOCKED, not inferred passes.

Official-extension checks must exercise login/unlock, generation, saving, actual content-script autofill and restart against an invented vault. Ad-blocking fixtures verify network/cosmetic integration and host exceptions; representative public-site comparisons are needed to claim AdGuard-comparable effectiveness. Keep real account data, screenshots, logs and per-run evidence in ignored local artifacts.
