---
name: cod-implement
description: Implement and deliver a focused Cod repair or product change while preserving UI, CLI, provider and persistence behavior.
---

# Implement a Cod change

- Read `AGENTS.md`. Check the current source, Git status and nearby tests. Use the issue to record the user outcome and acceptance before changes. Check the closest existing surface and relevant reference product for interaction work.
- For new controls check keyboard and mouse use, focus return, accessible name/state and persistence. For changing visual states use a full-window interactive mock with representative content. Extend shared UI primitives before adding feature-specific styles.
- For saved provider payloads verify the same payload survives restart or reconnect and the next user action succeeds. After failed send, preserve the draft and verify a single explicit retry. For latency, time input to visible result with representative histories and background activity.
- Use [cod-verify](../cod-verify/SKILL.md) on the committed candidate. Inspect the diff and run fast plus scoped checks. Publish through the issue's PR, wait for the required checks and verify the merged tree matches the tested candidate.

## Delivery cleanup

Keep useful cause and result evidence under ignored `artifacts/`. Check ownership and active callers before removing disposable worktrees, frozen inputs, generated builds or caches. Remove only owned completed inputs, preserving unreviewed changes and shared dependencies. Record material reclamation and exceptions privately.
