---
name: cod-diagnostics
description: Capture bounded local diagnostics before investigating slow typing, freezes, high memory use or excessive tabs in a running Cod desktop app. Use before proposing a performance fix; do not apply to unrelated applications or CI fixtures.
---

Use evidence from the user's running Cod before choosing a cause. A test fixture, stale session PID or background provider process is not the user's active agent.

Locate the intended profile from an explicit data directory, `COD_DATA_DIR`, or Cod's platform default. Confirm the session marker identifies a live Cod/Electron main process and the runtime journal's `application` role identifies its renderer. If multiple profiles or windows make identity ambiguous, clarify which one is affected. Never attach a debugger that pauses runtime, inspect private chat DOM, open a GUI, change system configuration, or take a heap dump by default.

The bundled macOS helper uses only the standard library and read-only system tools:

```sh
python3 "$SKILL_DIR/scripts/capture.py" --data-dir "$COD_DATA_DIR" --out "$PRIVATE_REPORT_DIR" --phase idle --seconds 30
```

`--out` must name a new private directory under ignored `artifacts/` or `reports/` (or a private temporary directory). The output includes sensitive stack paths; keep it local. The helper reads only bounded session and journal metadata and records the size of `workspace.sqlite` from its filesystem metadata. It emits aggregate counters and does not read workspace contents. Live WebContents counts and provider subprocess counts describe different things.

For an intermittent issue, coordinate one capture with the user: first a quiet baseline, then `--phase repro` during the explicitly agreed action. Record the actual action/time separately without private content. `--phase repro` labels a window; it does not prove the user's action overlapped it. The helper prints READY and records timing/latencies. Avoid duplicate stack sampling when another agent already owns a capture. Use `--no-stacks` for a light repeat; the default takes one short non-pausing OS stack sample per main/application renderer after its measurement window. On another OS, adapt supported read-only tools and state clearly which evidence is unavailable.

Assess CPU from cumulative process CPU time divided by monotonic elapsed time; macOS 100% is one logical core. Report RSS, thread counts, system memory pressure, swap, load and logical CPU count alongside CPU. Samples are observations, not proof of responsiveness, causality or lack of a freeze. Check actual sleep/wake records before calling a gap a hang; `Sleep` alone also matches assertions. When needed, inspect the last matching entries from `pmset -g log` with `rg 'Entering Sleep state|Wake from|DarkWake from'` and `tail -20`, under a finite command timeout; do not copy the complete system power log into the report. Respect unavailable commands and sample errors rather than silently assuming normal results.

Report the observed counts and matched capture window first, then separate hypotheses from established causes. Stripped Electron sample symbols and nearest-symbol offsets are not reliable JavaScript stack attribution. A successful save or correct final value does not prove smooth typing. If the repro was missed, say so and arrange a targeted capture instead of refactoring based on an idle sample. Request a full heap dump only for a specific unresolved memory question with explicit consent and a plan for its size/privacy; do not upload raw diagnostics to GitHub.
