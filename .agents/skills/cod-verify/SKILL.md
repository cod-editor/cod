---
name: cod-verify
description: Verify a Cod feasibility gate or implementation checkpoint against its acceptance scenarios and report evidence-backed results, including keyboard, CLI and restart behavior where relevant.
---

# Verify a Cod checkpoint

Read AGENTS.md and the applicable criteria in docs/specs/implementation.md.
Determine the actual commands from the current package scripts and probe READMEs; never assume the historical test suite still exists.

1. List the criterion IDs being verified and the real environment: OS, app build and provider/extension versions where relevant.
2. Run the relevant scenarios. Cover UI and CLI parity, keyboard access, persistence and failure handling when the criterion includes them.
3. Use real Electron, Git and terminal processes for their corresponding behavior. Scripted provider fakes establish UI behavior; separately label live provider and extension evidence.
4. Inspect screenshots before using them as evidence. Keep private accounts, page content and credentials out of tracked artifacts.
5. Record PASS, FAIL or BLOCKED per criterion with a command/test name and concrete output or artifact location. An unavailable platform is BLOCKED, not an inferred pass.
6. Keep reproducible failures, logs and screenshots in ignored artifacts. Report material outcomes concisely and update existing limitations when needed. Rerun affected checks after fixes without weakening assertions.

Formatting-only preparation needs formatting and diff checks, not a fabricated application test.
A missing package script is a tooling gap to report, not permission to claim that tests ran.
Keep the stakeholder report short: result, evidence and remaining blocker. Preserve full technical evidence in the execution record.
