---
name: cod-feasibility
description: Investigate and prove Cod's browser, ad-blocking and native agent integration gates before product implementation. Use when starting the restart or resolving an unproven integration.
---

# Prove Cod's foundation

Read AGENTS.md, docs/vision.md and the compatibility acceptance boundaries in docs/specs/implementation.md.

1. Select an unfinished gate. Record the exact platforms and versions being tested.
2. Consult current primary documentation, installed CLI help and relevant source. Distinguish a documented claim from an observed result.
3. Build the smallest executable probe needed. Keep exploratory probes under ignored artifacts/. Promote reusable verification helpers into tests/support/ with reproduction commands in tests/README.md. Do not build the product around an unverified adapter.
4. Run the gate's acceptance scenarios. Use invented data and dedicated test accounts; never export a personal password vault or print authentication material.
5. Record PASS, FAIL or BLOCKED per platform/provider case, with reproducible commands and evidence. Mocks cannot pass a live-compatibility gate.
6. Summarize material compatibility limitations in the existing README or contracts. Keep detailed run evidence in ignored artifacts, not a new tracked report.

Continue independent checks when access is missing. Do not ask the stakeholder to do the team's debugging.
If a requirement cannot be met without substantial compatibility maintenance, report the concrete obstacle and options. Do not silently drop the requirement or substitute a raw model API for a coding agent.
Do not proceed to dependent product work until the required gates pass or the stakeholder revises the scope.
