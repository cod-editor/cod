---
name: cod-verify
description: Verify a Cod change in isolated Electron or service tests, including rendered UI and keyboard acceptance.
---

# Verify a Cod change

Use the issue's acceptance scenarios and record the exact revision, environment and results. Use invented fixtures. Test the relevant neighboring path and distinguish automated behavior from native live-account evidence.

## Run

```sh
npm run check && npm run build && npm run test:unit
docker build -t cod-test-electron:local tests/support/electron
scripts/verify-electron-linux.sh tests/e2e/FILE.spec.ts --grep 'SCENARIO'
scripts/verify-electron-linux.sh --services
```

Use Docker/Xvfb on an isolated display with Chromium's sandbox on. For the private Linux runner use `node scripts/verify-electron-remote.mjs --config PRIVATE_CONFIG --source WORKTREE -- TEST_ARGS`. Use `--no-wait` to submit without blocking, `--result RUN_ID` to retrieve an existing run, and `--recover-evidence RUN_ID` for a collection failure. Freeze and match test inputs to the candidate. Run `npm run test:preflight` or pass `--ci` to the remote runner for cross-cutting changes beyond scoped coverage. Required GitHub gates are fast checks, services, all three Electron shards and the aggregate `e2e` result.

## Visual review

Capture base and candidate in real Cod with the reported state, matching viewport, fonts and scale. Open the actual candidate PNG at readable size. Inspect the affected row or column for baselines, icon centers, spacing, focus and clipping. Check open, closed, disabled and narrow states as relevant. Use a crop to check pixel alignment while retaining the full window. Record the independent reviewer's observations before merge and rerender after material changes.

- Settings, composer menus and disabled controls live in `tests/e2e/ui-interactions.spec.ts`, `navigation-settings.spec.ts` and `native-chat.spec.ts`. For the composer include the reported agent and Stop state when relevant.
- Overview and tab action fixtures live in `workspace-overview.spec.ts` and `icon-controls.spec.ts`. Browser picker captures live in `browser.spec.ts`. Keep evidence under ignored `artifacts/`.
- Generate interactive examples with `node scripts/build-ui-preview.mjs gallery` or `workspace`. For packaged macOS checks use `node tests/support/electron/check-package.mjs release/PACKAGE_DIRECTORY`.
