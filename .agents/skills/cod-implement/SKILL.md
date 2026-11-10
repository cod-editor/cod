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
6. Run affected checks, format changed files and inspect the diff. Invoke cod-verify for the checkpoint's verification procedure.
7. Update existing user or contract documentation only when behavior or limitations change. Keep per-run results and handoffs in ignored artifacts. Commit coherent checkpoints; publish only through an authorized PR.

Keep runtime instructions for agents using Cod distinct from these development skills. Add runtime documentation as commands become real; do not teach nonexistent commands.
Do not restore the previous role system, require a separate tests PR, add cloud abstractions or implement deferred features merely because historical files did so.
