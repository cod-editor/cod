# Working on Cod

## Before starting

Read [the vision](docs/vision.md) and, for implementation, [the contracts](docs/specs/implementation.md). Inspect current files and Git status; preserve unrelated work. Historical code and issues are references, not requirements. Resolve missing decisions only when they materially change scope or outcome; complete authorized work without repeated permission requests.

## Workflow

1. Identify the user outcome, requirements and relevant compatibility gaps before choosing an implementation.
2. Make focused changes with clear module boundaries. Keep UI, CLI, persistence and native provider behavior aligned.
3. Verify observable behavior with appropriate tests. Use real Electron, Git and PTYs with invented fixture data; distinguish protocol fixtures from live compatibility.
4. Format changes and inspect the diff for unintended edits, secrets and regressions.
5. Report the result and limitations concisely. Never claim an untested capability works. Commit coherent completed changes with imperative subjects and no AI attribution.

## Design

Validate the design as a whole rather than patching each stakeholder comment in isolation:

1. Walk realistic tasks, context switches, interruptions, returning later and recovery.
2. Inspect established products such as Zed and Agterm. Distinguish observed behavior from documentation and inference; justify departures from familiar conventions.
3. Model objects, actions and state transitions before adding controls. Keep internal implementation categories out of the UI.
4. Check naming, action placement, focus, discoverability and persistence across neighboring screens and exceptional states.
5. Inspect rendered screenshots at realistic sizes and exercise keyboard/mouse paths. Combine scenario walkthroughs, reference comparison, model review and behavioral tests.
6. Iterate until contradictions are resolved or explicitly identified. The stakeholder sets priorities; agents own research, QA and debugging.

Apply established preferences everywhere: compact editor conventions, keyboard-first operation, sparse persistent controls, no redundant labels or explanatory clutter. Every visible control needs a reason to remain visible rather than use a shortcut, context menu or Commands. Minimalism must preserve discoverability and keyboard focus. Do not infer a psychological profile from design preferences.

When asked to revise the standalone mock, apply and validate the change without another confirmation; keep production changes separate unless requested. Ask one question at a time. Put durable product decisions in the vision and behavior contracts in the spec.

## Documentation and repository hygiene

Keep published documentation useful to users and maintainers: running the app, current limitations, requirements and durable contracts. Do not add agent handoffs, chronological progress diaries, per-run acceptance reports or duplicate design essays. Store raw evidence, screenshots, private notes and temporary handoffs under ignored `artifacts/` or `reports/`; summarize only material conclusions in the user response or relevant existing documentation.

This repository is public. Never publish employer data, internal URLs, credentials or private browsing content. Keep secrets in environment variables and inspect artifacts before publication. Use plain language and ASCII punctuation; do not wrap prose at a fixed column width. Stage specific paths, never `git add .` or `git add -A`. Never push directly to master; publish through a pull request when authorized.

Keep `release/` tidy: after successful packaging retain only the newest generated package for that platform and architecture. Retain a running package until a later packaging run after it exits; if process detection is unavailable, skip pruning. Preserve the previous working package when packaging fails, and never prune unrelated files or another invocation's staging directory.

## Execution and verification

Never open test windows on the stakeholder's active desktop. Use headless browsers or an isolated graphical environment with its own virtual display; otherwise report graphical checks as blocked and continue non-GUI checks. On macOS wrap long jobs in `caffeinate -dimsu`. Check sleep events before diagnosing a hang. Never disable the Chromium sandbox to obtain a pass.

Read the applicable repository skill before using it: [.agents/skills/cod-feasibility/SKILL.md](.agents/skills/cod-feasibility/SKILL.md), [.agents/skills/cod-implement/SKILL.md](.agents/skills/cod-implement/SKILL.md), or [.agents/skills/cod-verify/SKILL.md](.agents/skills/cod-verify/SKILL.md). These are development instructions, separate from the shipped runtime skill.

Use the commands in [README](README.md) and `package.json`. `npm run check` checks formatting and TypeScript, not behavior. `npm run test:isolated` runs the selected real-Electron suites in Docker/Xvfb; its image prerequisites are in [tests/README.md](tests/README.md). Select completed slices while concurrent work is in progress. Never exclude production code from type checking to hide an error, weaken assertions to obtain a pass, or equate a mocked provider with live account compatibility.
