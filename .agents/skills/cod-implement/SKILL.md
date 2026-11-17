---
name: cod-implement
description: Implement a bounded Cod product slice from the restart spec after its feasibility gates pass, keeping UI, CLI, persistence and provider capabilities aligned.
---

# Implement one Cod slice

Read AGENTS.md, docs/vision.md and docs/specs/implementation.md.
If required feasibility gates have not passed, use cod-feasibility for dependent work. An explicit PM work order may schedule an independent slice; keep unresolved gates explicit and do not claim complete v1 readiness.

1. Select the next unfinished slice and define a small checkpoint with its acceptance criterion IDs and owned files. Use a working branch; preserve unrelated edits and intentional restart deletions.
2. Resolve routine library and interaction choices from the spec. Record consequential decisions with reasons. Ask one focused question only when the choice changes product scope or resolves a consequential user-facing ambiguity.
3. Write or adapt behavioral tests for the checkpoint, then implement the smallest vertical slice that satisfies them. Tests drive the real Electron app for user-visible outcomes; use fakes for repeatable provider behavior, not proof of native compatibility.
4. Route UI and CLI through shared application operations. Explicitly target background resources, preserve native provider identity and expose unsupported capabilities honestly.
5. Keep external browser pages isolated from privileged app APIs. Preserve unsaved documents and draft review comments across relevant failure paths.
6. Run focused checks while implementing, format changed files and inspect the diff. Invoke cod-verify for the checkpoint's verification procedure.
7. Finalize relevant documentation and commit the coherent source before [full pre-push preflight](../../../tests/README.md#full-pre-push-preflight). Every push requires successful CI fast checks, services and all three Electron shards against that exact frozen revision, including documentation-only changes. Focused checks are not a substitute. Further edits invalidate the snapshot and require a new full preflight. If blocked, report the cause instead of pushing for CI to discover it. Publish through the authorized PR only after this gate, and still require green GitHub checks. Keep raw evidence in ignored artifacts.
8. After verified delivery, complete [delivery cleanup](#delivery-cleanup) before marking the checkpoint done. Cleanup does not end an authorized backlog; continue to the next agreed item.

Keep runtime instructions for agents using Cod distinct from these development skills. Add runtime documentation as commands become real; do not teach nonexistent commands.
Do not restore the previous role system, require a separate tests PR, add cloud abstractions or implement deferred features merely because historical files did so.

## Delivery cleanup

Cleanup is part of delivery, not a separate permission request for known disposable files. Apply these checks to owned paths; retain and report anything whose ownership or safety is unclear.

1. Check Git status, worktree registrations and active jobs/callers with neighboring owners. An idle directory may still supply a shared helper, private configuration or another task's next step. Keep paths still in use. Measure the owned cleanup scope before deletion.
2. Retain only useful cause-proof, input identity, result logs and representative screenshots in an ignored private location outside directories being removed. Preserve unresolved-failure evidence. Preserve source changes and unknown untracked files; an explicitly approved patch/archive must be checked before removal, and archiving alone does not authorize discarding source.
3. Remove completed, owned frozen inputs, copied dependency trees, generated builds, obsolete run directories and worktrees whose outputs are retained. Keep reusable dependencies/caches only when still used and bounded. Use existing remote finite-run retention; do not clear another owner's runs or caches. At each completed run boundary, discard disposable inputs after checking outputs instead of accumulating them until final delivery; no full-repository sweep is needed per iteration.
4. Leave the target worktree's working directory before removing it with `git worktree remove`. Check for active path references before pruning stale registrations. Never force past unreviewed changes. Delete branch refs only after their checked PR merge is verified and no task still needs them; retain uncertain refs and clarify only if their removal is required.
5. Never blanket-delete `artifacts/`, root `node_modules` or wildcard matches belonging to others. Do not change the user's root checkout/dist, profiles, credentials or drafts. Follow [AGENTS.md](../../../AGENTS.md#documentation-and-repository-hygiene) for release retention: preserve running packages, the previous working package after packaging failure and unrelated staging directories.
6. Briefly report before/after size, reclaimed space and intentional exceptions in the completion response or private evidence, not a public cleanup diary. A retained active dependency is an exception to report, not permission to delete it or a reason to leave other safe cleanup unfinished.
