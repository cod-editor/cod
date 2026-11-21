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
4. For changes to visible UI, run [Visual review](#visual-review) before publication. Inspect screenshots before using them as evidence. Keep private accounts, page content and credentials out of tracked artifacts.
5. Record PASS, FAIL or BLOCKED per criterion with a command/test name and concrete output or artifact location. An unavailable platform is BLOCKED, not an inferred pass.
6. Keep reproducible failures, logs and screenshots in ignored artifacts. Resolve failures by proving their cause without weakening assertions. Apply the [pre-push checks](../../../tests/README.md#pre-push-checks) and record the revision, selected scenarios and results. When a full Linux preflight is needed, record its frozen input identity and confirm that the complete result applies to the exact candidate. Verify required GitHub checks before merging.
7. Before returning verification ownership, apply [delivery cleanup](../cod-implement/SKILL.md#delivery-cleanup) to finished verification inputs. Keep the evidence and shared paths still needed by the implementation owner.

Documentation-only changes need fast checks before pushing.
A missing package script is a tooling gap to report, not permission to claim that tests ran.
Keep the stakeholder report short: result, evidence and remaining blocker. Preserve full technical evidence in the execution record.

## Visual review

Render the full affected Cod window in an isolated environment with invented fixture data. Open and inspect the captures at a realistic size. Exercise the relevant enabled, disabled, on, off and keyboard-focus states, including a narrow window or pane when layout can change. Follow AGENTS.md for interactive mocks when the decision depends on switching states.

Compare the render with the nearest existing Cod surface and a relevant pattern from Zed or Agterm. State which references you observed in a running app and which you checked in source or documentation. Check visual hierarchy, spacing, visible focus and state, and whether the action is easy to find in the surrounding UI. If a teammate is available under the existing coordination workflow, ask them to inspect the same captures. Fix material issues with shared Cod primitives and render again.

Keep screenshots and review notes in ignored local artifacts. If an isolated renderer is unavailable, record the concrete blocker and mark the visual review BLOCKED. Continue the functional checks that can run.
