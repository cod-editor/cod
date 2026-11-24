# Working on Cod

## Product and boundaries

- Cod is a keyboard-first desktop workspace for directing coding agents and reviewing their work. Use compact shared controls from `src/ui-kit/` and existing interaction helpers in `src/ui/`.
- Reuse existing mechanisms and keep one application model. UI and CLI share operations. Inspect adjacent behavior and tests before changing persistence, input, focus or recovery.
- Keep native provider identity and a single controller per session. Opening or discovering a session must not send a prompt. Preserve drafts, verify uncertain delivery before retrying and never silently overwrite external edits.
- Keep web content sandboxed and outside the privileged app bridge. Registered response pages bind their origin and recipient. Remote private actions require explicit verified pairing. Product and provider trust stay separate.

## Delivery

- Use [GitHub Issues](https://github.com/cod-editor/cod/issues) for the queue. Search for an existing issue, write observable acceptance, and apply `in-progress` before implementation. Prioritize new defects at the next safe checkpoint. Use separate worktrees for independent work. Link the PR and close only after delivery.
- Public issues and PRs use invented data. Keep real profiles, raw logs, screenshots, transcripts and paths in ignored local artifacts. Stage specific files. Commit coherent changes and merge through a PR after required checks.
- Check `npm run check`, `npm run build` and `npm run test:unit` before pushing. Verify changed and neighboring behavior in [isolated Electron](.agents/skills/cod-verify/SKILL.md). Never open test windows on the user's active desktop or disable Chromium's sandbox. Run long macOS jobs with `caffeinate -dimsu`.
- For visual changes open the candidate screenshot in the reported state and inspect the whole row or column at readable size. Check baselines, icon centers, gaps and focus. Record the visual review separately from geometry assertions.
- Keep local `master` clean. After a checked merge, fast-forward only a clean `master`. Use `npm run --silent delivery:status` to distinguish source, build and running app.
- After packaging, keep the newest working output for each platform and architecture plus any running package. Preserve the previous package on failure.

## Skills

- [cod-implement](.agents/skills/cod-implement/SKILL.md) for scoped repairs and delivery cleanup.
- [cod-verify](.agents/skills/cod-verify/SKILL.md) for test runners and UI acceptance.
- [cod-feasibility](.agents/skills/cod-feasibility/SKILL.md) for unproven integrations.
- [Cod operating skill](plugins/cod/skills/cod/SKILL.md) for driving a running workspace through `codctl`.
