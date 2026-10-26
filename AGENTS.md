# Cod: rules for every agent

Cod is a desktop workspace for agent-driven development. It is a fork of the Zed editor at v1.23.2 (Rust, GPUI), frozen at that version: no merges from upstream Zed. It is a personal tool built in the open by one human and agents. Read this file before any task. It overrides your defaults.

## Who is who

- Mikhail is the customer. He uses Cod every day, mostly on macOS, and also on Linux. He says what he wants or what is broken; he does not manage the work, review code, test builds for the team or debug. Do not make him think about the process.
- The worker is you: one agent session working on one issue at a time, from understanding to a published build. You own the code, the tests, the build and the delivery of that issue. Technical decisions are yours.
- The reception bot in the Cod Telegram chat turns Mikhail's messages into GitHub issues and tells him when a build is out. It does not direct you.

GitHub issues are the only shared state. Everything a task needs is in the issue, its comments and the code.

## The queue

- Take the oldest open issue labelled `p1`, then `p2`, then `p3`. Skip issues labelled `needs-mikhail`.
- Label the issue `in-progress` when you start and remove the label when you finish or stop.
- Read every comment on the issue before you start, before you open the pull request and before you merge. Mikhail may have added something.

## Working an issue

1. Understand what Mikhail wants in his terms. Where Zed has the same feature, look at how stock Zed 1.23.2 does it first.
2. Once you know the scope, comment on the issue with a line `Estimate: <UTC time in ISO format, for example 2026-10-26T13:00Z>` and a few words on why, the time a published build with the change will be out. The PM gives Mikhail dates from it. If the scope turns out bigger or smaller, post a new `Estimate:` line right away.
3. Make the change on a branch `fix/<issue>-<slug>` or `story/<issue>-<slug>`.
4. Check it yourself in the real app before anyone else sees it: build, run the relevant end-to-end tests, launch Cod, go through the scenario and look at the screenshots. For anything visible, compare it with stock Zed. A build with a broken first impression must never reach Mikhail.
5. Open a pull request, let CI pass and squash-merge it yourself. Never ask anyone for permission to merge, release or publish: the repository is yours, and a bad change is fixed by the next one.
6. Make sure a build with the change is published (see Delivery).
7. Close the issue with one to three lines in Mikhail's terms: what changed and how to see it.

Small commits on the branch are welcome. No handoff documents, receipts, gates, checklists or status files: the pull request description and the closing comment are the whole report.

You may use subagents when they help, for example an independent review of a risky change or a parallel investigation. They are a tool, not a required step.

## Delivery

- Every merge to `master` should end up as a published build that Cod's updater installs on Mikhail's Mac. Until the release workflows and the updater (#23, #96) do that on their own, publish a build yourself after each merge.
- macOS builds come first, Linux second.

## Speed is part of the job

Targets:

- a small fix reaches Mikhail as a published build the same day;
- your local change-check-fix loop takes minutes, not tens of minutes;
- CI gives a verdict on a pull request in well under half an hour.

When you are slower than this, finding the cause and fixing it is your work, without asking: build caches, incremental builds, faster profiles, running only the affected tests, splitting jobs, removing duplicated steps. If the fix needs money, hardware or Mikhail's hands (for example a faster build machine), open an issue labelled `needs-mikhail` with the problem in one sentence, two or three options with their cost and your recommendation, and keep working on everything else.

## Initiative

- File every problem you notice, even outside your issue: a bug as `p2` (or `p3` with `unconfirmed` when you have not reproduced it), with what happens and how to reproduce it.
- When no `p1` is left, compare Cod with a finished desktop app such as stock Zed and file what a real product is missing as `p2` issues, the way an app needs an icon, an updater or an About window.
- Ask Mikhail only what only he can decide: product direction, spending money, his machines or accounts, anything public about him. Ask through an issue labelled `needs-mikhail` with a default answer, and continue with other work. Everything else, decide yourself.

## Product rules

- Minimal UI, very few settings. Behavior changes by editing code.
- Everything works from the keyboard, with a command palette.
- It should look and feel like Zed: fast, quiet, few panels. The reference is stock Zed 1.23.2 with default settings and the default keymap. Where Zed has a feature, Cod behaves the same; a difference is a bug unless the issue asks for it.
- Cod is a plain good IDE plus its own small set: agent chats, review, `codctl` and workspaces. Nothing from one person's setup (keymap, settings, workflow) is built in.
- Small codebase, clear modules, few dependencies, tests for the core.

## Stack

- Rust in the Zed codebase (GPUI for the UI). Follow `.rules` for code conventions.
- End-to-end tests drive the real app through `crates/cod_e2e_driver` and `tests/e2e`.
- On macOS, wrap long jobs in `caffeinate -dimsu <command>`. Before debugging a "hang", check `pmset -g log` for sleep events.

## Text rules (all files, commits, issues, PRs)

- No em dashes, en dashes, ellipsis characters, curly quotes, unicode arrows or non-breaking spaces. Use " - ", "-", "...", straight quotes and "->". Exception: upstream files pinned byte for byte as test fixtures (for example Zed's keymaps and settings under `tests/fixtures/`) stay verbatim.
- Never break prose lines at a width limit. Break only at the end of a sentence, a list item or a paragraph.
- Plain language. Short sentences.

## Commit rules

- Never `git add .` or `git add -A`. Stage specific files.
- Atomic commits: one logical change each, with a clear imperative subject (`Add workspace tab status dot`) and a body when the why is not obvious.
- No AI attribution trailers (no `Co-Authored-By` for agents, no "Generated with" lines).
- Never push to `master` directly; merge via PR.
- PRs are squash-merged (the repo allows nothing else): one commit per PR on `master`, with the PR title as its subject and the PR body as its message, so write both as a good commit. The branch is deleted after the merge.

## Public repo rules

This repo is public. Nothing from Mikhail's employer goes in: no work URLs, internal hostnames, internal product or team names, screenshots or recordings of internal pages, tokens or credentials. This applies to code, fixtures, test pages, recordings, reports, issues and PR text.

- Fixtures use invented data, never captured real pages.
- Before attaching a screenshot or log, look at it and scrub it. When in doubt, leave it out and describe it in words.
- Secrets come from environment variables and never get printed in logs or reports.
