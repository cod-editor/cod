# Working on Cod

## Before starting

Read [the vision](docs/vision.md) and, for implementation, [the contracts](docs/specs/implementation.md). Inspect current files and Git status; preserve unrelated work. Historical code and issues are references, not requirements. Resolve missing decisions only when they materially change scope or outcome; complete authorized work without repeated permission requests.

## Workflow

New user defect reports go to the front of the pending repair queue. Preserve the current coherent change and reach a safe verification boundary before switching; do not abandon work or end execution just because feedback arrived. Treat a status question as a request for an update while continuing the authorized queue.

For an authorized repair backlog, continue from each verified checkpoint to the next agreed item without requiring a new prompt. Publishing a checkpoint or reporting status does not complete the backlog. Use completion notifications for long checks and resume dependent work when they finish; stop only for an actual blocker, a user pause or completion of the requested scope.

GitHub Issues in this repository are the canonical repair queue. Search existing issues before creating one; keep one current issue per coherent outcome, with concise acceptance criteria, ordering/dependency links and the implementation PR. Record planning-only work explicitly: an issue does not itself authorize implementation. Task owners maintain their issues through verification and publication, and close them only after the relevant checked merge or an evidence-backed audit. Use Completed for delivered behavior and Not planned for obsolete or duplicate work, linking the surviving issue when applicable. Keep historical architecture reports out of the active queue unless their requirement or defect still applies to the current application.

Before publishing an issue, comment, PR or attachment, inspect its exact content and sanitize it. Publish only product behavior and invented fixtures: no personal or employer information, internal names/URLs/IPs, account/profile details, personal filesystem paths, screenshots of real work, raw logs or session transcripts. Keep private evidence in ignored local artifacts and publish only the minimum conclusion needed to understand the issue.

1. Identify the user outcome, requirements and relevant compatibility gaps before choosing an implementation.
2. Make focused changes with clear module boundaries. Keep UI, CLI, persistence and native provider behavior aligned.
3. Verify observable behavior with appropriate tests. Use real Electron, Git and PTYs with invented fixture data; distinguish protocol fixtures from live compatibility.
4. Format changes and inspect the diff for unintended edits, secrets and regressions.
5. Publish coherent verified checkpoints periodically and merge their pull requests once required checks pass; this is standing user authorization. Never bypass failing required checks.
6. Before marking a delivered checkpoint done, perform the [workflow skill delivery cleanup](.agents/skills/cod-implement/SKILL.md#delivery-cleanup), preserving active owners, source changes and useful private evidence.
7. Report the result and limitations concisely. Never claim an untested capability works. Commit coherent completed changes with imperative subjects and no AI attribution.

## Design

Before adding a protocol, service, abstraction or compatibility layer, inspect the existing mechanisms and relevant reference products. Prefer solving the problem through an existing interface. Justify any additional mechanism with a concrete unmet requirement and account for its lifecycle, failure modes, maintenance and verification cost; do not add layers merely because they are available.

Validate the design as a whole rather than patching each stakeholder comment in isolation:

1. Walk realistic tasks, context switches, interruptions, returning later and recovery.
2. Inspect established products such as Zed and Agterm. Distinguish observed behavior from documentation and inference; justify departures from familiar conventions.
3. Model objects, actions and state transitions before adding controls. Keep internal implementation categories out of the UI.
4. Check naming, action placement, focus, discoverability and persistence across neighboring screens and exceptional states.
5. Inspect rendered screenshots at realistic sizes and exercise keyboard/mouse paths. Combine scenario walkthroughs, reference comparison, model review and behavioral tests.
6. Iterate until contradictions are resolved or explicitly identified. The stakeholder sets priorities; agents own research, QA and debugging.

Before implementation, compare the complete user task with the chosen reference product and record observable acceptance behavior in the existing spec: keyboard and mouse entry, selection versus activation, rename, cancel, focus return, persistence and recovery. Explicitly identify intentional omissions; do not assume that an unimplemented ordinary action is out of scope. Tests must check the intended task, not merely confirm the bindings or controls the implementation happened to add.

Treat user-adjustable properties as part of the initial feature: identify their defaults, configuration ownership, validation, live application and reset behavior. Extend the shared settings schema and components rather than accumulating isolated preference dialogs.

For input, streaming and persistence paths, verify responsiveness and bounded resource use with representative large histories and attachments as well as empty fixtures. Distinguish correctness tests from performance evidence; a saved final value alone does not prove responsive typing. When fixing a defect, inspect neighboring actions and test the proposed cause directly before declaring it resolved.

Apply established preferences everywhere: compact editor conventions, keyboard-first operation, sparse persistent controls, no redundant labels or explanatory clutter. Every visible control needs a reason to remain visible rather than use a shortcut, context menu or Commands. Minimalism must preserve discoverability and keyboard focus. Do not infer a psychological profile from design preferences.

Use the shared UI primitives in `src/ui/primitives.ts`, behavior helpers in `controls.ts`/`action-feedback.ts`, and the spacing/control tokens in `src/ui/components.css`. Extend these components before inventing a feature-specific button, field, toolbar or dialog style. Feature CSS may arrange components but must not override their basic geometry or target every nested `div`/region. Verify new control states and spacing in isolated rendered tests, including narrow panes, keyboard focus and disabled states.

When asked to revise the standalone mock, apply and validate the change without another confirmation; keep production changes separate unless requested. Ask one question at a time. Put durable product decisions in the vision and behavior contracts in the spec.

## Documentation and repository hygiene

Keep published documentation useful to users and maintainers: running the app, current limitations, requirements and durable contracts. Do not add agent handoffs, chronological progress diaries, per-run acceptance reports or duplicate design essays. Store raw evidence, screenshots, private notes and temporary handoffs under ignored `artifacts/` or `reports/`; summarize only material conclusions in the user response or relevant existing documentation.

This repository is public. Never publish employer data, internal URLs, credentials or private browsing content. Keep secrets in environment variables and inspect artifacts before publication. Use plain language and ASCII punctuation; do not wrap prose at a fixed column width. Stage specific paths, never `git add .` or `git add -A`. Never push directly to master; publish through a pull request when authorized.

Keep `release/` tidy: after successful packaging retain only the newest generated package for that platform and architecture. Retain a running package until a later packaging run after it exits; if process detection is unavailable, skip pruning. Preserve the previous working package when packaging fails, and never prune unrelated files or another invocation's staging directory.

## Execution and verification

Never open test windows on the stakeholder's active desktop. Use headless browsers or an isolated graphical environment with its own virtual display; otherwise report graphical checks as blocked and continue non-GUI checks. On macOS wrap long jobs in `caffeinate -dimsu`. Check sleep events before diagnosing a hang. Never disable the Chromium sandbox to obtain a pass.

Read the applicable repository skill before using it: [.agents/skills/cod-feasibility/SKILL.md](.agents/skills/cod-feasibility/SKILL.md), [.agents/skills/cod-implement/SKILL.md](.agents/skills/cod-implement/SKILL.md), or [.agents/skills/cod-verify/SKILL.md](.agents/skills/cod-verify/SKILL.md). These are development instructions, separate from the shipped runtime skill.

Use the commands in [README](README.md) and `package.json`. `npm run check` checks formatting and TypeScript, not behavior. `npm run test:isolated` runs the selected real-Electron suites in Docker/Xvfb; its image prerequisites are in [tests/README.md](tests/README.md). Use focused checks during implementation. Before every push, including documentation-only changes, complete the full frozen Linux preflight in [tests/README.md](tests/README.md#full-pre-push-preflight): CI fast checks, service tests and all three Electron shards from the final committed source. Later source or configuration edits invalidate that full snapshot evidence. Report an environment or failing-test blocker; do not silently use CI as the first full run. A passing preflight increases confidence but does not guarantee identical OS timing or replace required green GitHub checks. Never exclude production code from type checking to hide an error, weaken assertions to obtain a pass, or equate a mocked provider with live account compatibility.
