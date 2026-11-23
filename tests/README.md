# Test environments and compatibility probes

Ordinary tests use invented repositories, pages, conversations and images. Live provider calls and official-extension checks are separate: they require native installations or an explicitly disposable account and must not run silently in public CI. Keep profiles, credentials, screenshots and run reports in ignored artifacts.

## Isolated application tests

From the repository root:

```sh
docker build -t cod-test-electron:local tests/support/electron
caffeinate -dimsu scripts/verify-electron-linux.sh
# Or select an application suite:
caffeinate -dimsu scripts/verify-electron-linux.sh tests/e2e/files.spec.ts
# Browser isolation, agent-page security and PTY service checks:
caffeinate -dimsu scripts/verify-electron-linux.sh --services
```

Omit `caffeinate` on Linux. The runner freezes source inputs, installs Linux dependencies and runs real Electron as an unprivileged user under Xvfb, with one Playwright worker. It does not open host desktop windows or mount personal profiles. Each run records its input hashes and results under `artifacts/verification/`.

Docker is required. The checked-in Dockerfile builds the default `cod-test-electron:local` image with Node.js, Electron system libraries, Xvfb and an unprivileged `node` user. Set `COD_LINUX_TEST_IMAGE` to use another compatible image. The runner needs network access for locked packages and the prebuilt Electron download. Do not reuse host-platform `node_modules` in Linux.

The OrbStack test environment uses an outer Docker seccomp exception for Chromium user namespaces; Chromium's own sandbox stays enabled. The runner checks actual renderer isolation. An unavailable image, display or sandbox is an environment blocker, not permission to add `--no-sandbox`.

## Visual review fixtures

For shared control work, start with the nearest surface in this index. Reproduce the reported state and compare it on the base and candidate with the same fixture data, viewport, interface text size and display scale. Capture the reported settings even when the default or enlarged view also passes. Use a reference from the design decision when it helps explain a difference. Inspect the actual PNG at a readable size. Record the visual judgment separately from the geometry assertion results.

| Control family                    | Fixture file and scenario prefix                                                                                                                                                | Captures and assertions                                                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Form controls and dialog actions  | `ui-interactions.spec.ts`, Shared dialog controls retain consistent geometry<br>`navigation-settings.spec.ts`, Settings groups readable font choices, Settings native selectors | `shared-settings.png`, `shared-browser-settings.png`, `settings-sections.png`, `settings-narrow-enlarged.png` and the Linux `native-settings-selector.png`. Check field alignment, reset action position, primary action height, overflow and native selection. |
| Commands and context menus        | `ui-interactions.spec.ts`, Shared picker roles                                                                                                                                  | `commands-disabled-narrow.png`, `commands-enlarged.png`, `tab-menu-shortcuts.png`. Check disabled reason, first-line shortcut alignment, menu width and focus return.                                                                                           |
| Overview rows and action buttons  | `workspace-overview.spec.ts`, Overview uses one compact selection surface                                                                                                       | `overview-mixed-normal.png`, `overview-mixed-narrow.png`, `overview-actions-hover.png`, `overview-actions-focus.png`. Check wrapped labels, icon and action alignment, selection fill and keyboard focus.                                                       |
| Tab and toolbar icons             | `icon-controls.spec.ts`, Close, unpin and neighboring icon buttons<br>`ui-interactions.spec.ts`, Compact tab actions                                                            | `icon-states-*.png`, `tab-*-action-hover.png`, `tab-*-action-pressed.png`. Check square targets, hover and pressed feedback, focus outlines and behavior at different display scales.                                                                           |
| Composer choices                  | `ui-interactions.spec.ts`, Keyboard model choice, Model menu preserves caret                                                                                                    | `model-reasoning-closed-controls.png`, `model-menu-above-composer.png`, `model-selection-error-rollback.png`. Check menu anchor, space above the composer, focus and error feedback.                                                                            |
| Browser pickers and managers      | `browser.spec.ts`, Local address suggestions, Site media permissions, Downloads survive tab closure, Optional bookmarks edit                                                    | `address-suggestions.png`, `site-permission.png`, `downloads.png`, `bookmarks.png`. Check selected row and secondary label legibility, action grouping and dialog dismissal.                                                                                    |
| Review toolbar and inline actions | `reviews.spec.ts`, Narrow review toolbar keeps, Diff review headings keep, Inline source comments keep their anchor                                                             | `*-review.png`, `*-geometry.json`, `compact-diff-headings-narrow.png`, `review-source-inline-range.png`. Check primary action hit points, path shortening, pane bounds and comment anchoring.                                                                   |

For the ordinary composer sizes, compare `model-reasoning-closed-controls.png`, `model-reasoning-13.png` and `model-reasoning-after-send-13.png`. Inspect the model and effort values and chevrons alongside other composer controls. For background activity, use the Codex late background results scenario in `native-chat.spec.ts`. Check neither, either and both counters next to Stop, and the focus when an open list loses its last running item.

For the Settings footer and closed selectors, use `shared-settings-normal.png` and `shared-settings-13.png`. The native selector and enlarged fixtures in the index cover opening a menu and constrained space.

Run a single family by passing its files and scenario prefixes to either isolated runner. For a broad pass across these families, use the following command.

```sh
caffeinate -dimsu scripts/verify-electron-linux.sh \
  tests/e2e/ui-interactions.spec.ts tests/e2e/navigation-settings.spec.ts \
  tests/e2e/workspace-overview.spec.ts tests/e2e/icon-controls.spec.ts \
  tests/e2e/browser.spec.ts tests/e2e/reviews.spec.ts \
  --grep 'Shared dialog controls|Settings groups readable|Settings native selectors|Shared picker roles|Overview uses one compact|Close, unpin and neighboring|Compact tab actions|Keyboard model choice|Model menu preserves caret|Local address suggestions|Site media permissions|Downloads survive tab closure|Optional bookmarks edit|Narrow review toolbar keeps|Diff review headings keep|Inline source comments keep'
```

For the configured SSH runner, pass the same arguments after its `--` separator. Find the PNGs under `output/test-results/` in the returned run directory. For a state missing from the index, capture it in the relevant existing scenario when practical. Capture the whole window to show nearby controls and clipping. A close crop can supplement the full view for pixel-level details.

If a capture is new, run the same fixture change against the base without the product fix. Keep the reported state available for the paired render even if the regression assertion fails there. An assertion can run separately from the capture so a base failure still leaves an inspectable image.

Keep a short record in the ignored run artifacts with the defect, base and candidate revisions, runner, fixture, filenames actually inspected, viewport, text size, display scale and an independent reviewer's concrete observation for each relevant state. Record any missing capture or unavailable review. For a geometry fix, measure the reported relationship where practical, such as the value and chevron inside a select, the baselines of adjacent choices, or the visible focus after a trigger disappears. Outer height and overflow checks cover different defects. Keep production captures and measurements without committing pixel goldens.

## Pre-push checks

Commit the source you intend to publish and run `npm run check && npm run build && npm run test:unit`. These are the fast checks used in CI and suffice for documentation-only changes.

For behavior changes, use the isolated Electron runner above to test the affected journeys and neighboring behavior that shares the changed path. Select files or use Playwright's `--grep`, and record the selection and result. Run `--services` if the change affects a covered service. After editing or rebasing, check the diff and repeat any checks affected by the new inputs. Resolve failures and report any environment blocker before pushing.

## Full Linux preflight

Use the full preflight for cross-cutting behavior changes when focused coverage is insufficient, such as changes spanning window lifecycle or session restoration. It is also useful to reproduce suite-wide interactions:

```sh
caffeinate -dimsu npm run test:preflight
# On the configured private Linux runner, without host builds or GUI:
node scripts/verify-electron-remote.mjs --config PRIVATE_CONFIG --source SOURCE_DIRECTORY -- --ci
```

Full mode refuses a dirty or uncommitted checkout and exports the complete Git commit, including README, docs, instructions, formatting configuration and the Check workflow. Ignored profiles, environment files and Git metadata are not exported. It records the revision and a SHA-256 manifest. The existing remote helper may live in another worktree: its versioned execution driver is frozen alongside the source, so it can verify a different committed candidate without changing that candidate. Remote retrieval checks that the checkout still matches the verified clean revision; `source-check.json` must say `sourceCurrent: true`. Recheck HEAD and Git status immediately before pushing. Any later source or configuration change invalidates that full snapshot and requires a new preflight.

The full plan validates the current Check workflow commands and shard matrix, rejecting an unrecognized change instead of silently omitting it. Fast checks run `npm run check`, `npm run build` and the complete `npm run test:unit`. Fresh job directories then run the service tests and each of the three unfiltered `npm run test:e2e -- --shard=N/3 --workers=1` partitions, using their existing builds and sandbox checks. Every group uses a fresh locked install; service or shard failure does not skip the other independent shards. A successful full preflight requires all five groups to pass in `output/preflight.json`. A skipped, incomplete, expired or stale run cannot count as a pass. Do not add filters, retries, assertion changes or a sandbox bypass to obtain a pass. The shared Playwright configuration rejects exclusive `.only` tests so they cannot silently shrink the complete run.

The local full plan runs jobs serially inside the existing 2 CPU / 3 GiB Docker limit, so it takes longer than GitHub's independent parallel machines. Coordinate the shared runner before starting another full job; its finite 45-minute lifetime includes queue time. Its Node 24 Debian Bookworm image, GTK/Xvfb packages, display/keymap and resource limits differ from GitHub's Ubuntu-latest host, and the frozen checkout omits Git metadata. Command, test inventory, shard boundaries and Playwright configuration match; OS behavior and scheduling are not claimed identical. Record these differences, retain cause-proof for failures, and diagnose known races directly. A successful preflight improves confidence rather than proving the absence of flakes. Required green GitHub checks remain the merge gate.

## Feedback and complete CI coverage

Native context-menu fixtures wait for an actual visible native viewport and use OS mouse entry and menu selection, retaining the established Electron native-key entry for keyboard context menus. A synthetic WebContents mouse event does not move the desktop pointer used by the popup. The fixtures also wait for Electron's `menu-will-show` event before selection input and for the popup close callback before subsequent hover or focus checks. Receiving the page's `context-menu` event only establishes the request; input sent earlier can reach the page and select the wrong item once the popup appears. Observe the native item callback to confirm the requested action; never invoke that callback to simulate keyboard activation. A controlled delayed popup covers this ordering without adding sleeps to the ordinary fixture. Cursor-change checks first establish a different hover target; a cursor that was already active need not emit another change. Failed Electron shards retain only fixture traces, failure screenshots and error contexts for seven days; live account probes remain separate from public CI.

The Check workflow runs fast checks before graphical setup. After they pass, service suites and three native Playwright shards run on independent standard Linux runners. Each shard keeps one worker and the Chromium sandbox; files stay serial internally (`fullyParallel` remains false). The unchanged full E2E file list is partitioned with `--shard=1/3`, `2/3` and `3/3`, not filtered or retried. The final `e2e` status succeeds only when fast checks, services and every shard succeed, including after an upstream skip or cancellation. Keep that context required in branch protection.

Use Playwright's `--list --shard=N/3` to inspect a partition without opening an application. New suites still belong in the full E2E command. Sharding reduces elapsed feedback time using independent CI machines; it does not reduce total test work or justify more workers on the local desktop. npm downloads already use the existing setup-node cache; builds are short and are rebuilt per runner rather than introducing a binary distribution layer.

## Private SSH test machine

`node scripts/verify-electron-remote.mjs -- tests/e2e/files.spec.ts` runs selected checks on a configured Linux machine without local Docker, builds or GUI windows. Set `COD_TEST_SSH_HOST` to an existing SSH alias, or use `--host` / `--config` with a private JSON file containing a `host` property. Keep personal destinations/configuration in ignored local files, never in the repository or public issue content. Known-host verification is required and agent forwarding is disabled.

The remote machine needs Node.js 24 or newer, rsync, Docker, flock, tar and an existing systemd user manager; the helper does not change system configuration or enable lingering. It creates only its owned `.cod-electron-tests` directory and finite transient user units, not a daemon or public CI runner. Its Docker image is built task-locally when missing. One suite runs at a time with the existing runner's CPU/memory limits, virtual display and Chromium sandbox. A run expires after 45 minutes, including queue time.

The helper reuses `verify-electron-linux.sh --freeze-only`, transfers that immutable allowlisted source incrementally and keeps package/Electron caches remotely. Uncommitted application/test inputs are included; Git metadata, profiles, private artifacts, reports and environment files are not. Source symlinks and inputs over 64 MiB are rejected. Only use public Cod source and invented fixtures. To run a different worktree through an external copy of the helper, pass `--source SOURCE_DIRECTORY`; source identity is verified again against the actual remote frozen input.

A collector-only failure can be repaired with `--recover-evidence RUN_ID` using the same helper, source and private destination. It never reruns test commands: recovery requires the original execution exit code zero, unchanged frozen inputs and every full-preflight group passing. It preserves the original failed result and marks the recovered collection explicitly. Failed tests cannot be relabeled as passing; missing evidence remains a blocker.

`--no-wait` returns after remote acceptance. Reconnect with the same helper, destination and `--result RUN_ID`; this retrieves the existing result and never starts the test again. Closing the client/SSH wait does not stop an accepted remote job. If transfer fails before acceptance, the prepared ID and private local request record identify the incomplete staging area; do not assume a test ran. At most four jobs may be pending/staged.

Results are retrieved to ignored `artifacts/remote-verification/RUN_ID`: exit status, input SHA-256 manifest, a log tail and bounded test artifacts/screenshots. Collection retains at most 100 output files and 64 MiB, plus the manifest and a 1 MiB log tail. It copies the preflight summary first, then Playwright failure traces, error contexts and failure screenshots, followed by other files from those same test results. Passing artifacts can use the remaining budget. The result reports total omissions and how many were from failed tests. Raw output copies are discarded after collection. Keep three completed runs locally and remotely, preserving active jobs; each owned npm/Electron cache is reset before a run if it exceeds 2 GiB. Keep the current and one recent owned Docker image, preserving images in use. Global Docker/builder caches and unrelated workloads are never pruned; insufficient free space is an explicit failure rather than permission to delete other data.

## Official Bitwarden flow

```sh
caffeinate -dimsu scripts/verify-integrated-browser-linux.sh FROZEN_INPUT_DIRECTORY
```

Use the `input/` directory produced by the application runner. This flow needs a disposable localhost Vaultwarden service, an invented account and the pinned official extension archive. Set up the dedicated fixture explicitly:

```sh
node tests/support/bitwarden/prepare-vault.mjs
docker compose -f tests/support/bitwarden/compose.yml up -d
npx playwright install chromium
node tests/support/bitwarden/create-account.mjs
node tests/support/bitwarden/check-vault.mjs
npm run prepare:bitwarden
```

Fixture files default to `artifacts/bitwarden-fixture/`; `COD_TEST_VAULT_DIRECTORY` overrides that directory. `COD_TEST_BITWARDEN_ARCHIVE` overrides the archive prepared under `artifacts/bitwarden/`. The flow mounts the invented account and public certificate read-only, never a personal vault or certificate private key. Container host networking must reach the loopback service. Certificates expire deliberately; inspect validity before reusing an old fixture. `docker compose -f tests/support/bitwarden/compose.yml stop` preserves the account volume. `node tests/support/bitwarden/stop-vault.mjs` removes the disposable service, volume and local account file; use it only to discard that fixture.

Never substitute real credentials. Trust exceptions use only the disposable certificate's calculated SPKI in the test process, not system trust or a global certificate bypass.

The flow uses real popup login, generation, manual saving, content-script autofill and restart/unlock. After initial login it explicitly reloads the already-open page once. It does not establish automatic submitted-login capture or all public-site compatibility. Vault text, passwords and screenshots are not logged; values are compared in memory.

## Additional checks

- `node tests/support/electron/check-package.mjs release/PACKAGE_DIRECTORY`: macOS signature, packaged CLI, PTY and asset checks without a GUI.
- `node tests/support/providers/native-plugin-config.mjs`: native parser checks using temporary profiles; no model prompt. Config acceptance does not prove authenticated hook execution.
- `node --test tests/providers/adapters.test.ts tests/providers/options.test.ts`: deterministic provider transport/options tests.
- `node --test tests/reviews/service.test.ts tests/projects/service.test.ts tests/workspace-layout/*.test.ts`: persistence, real Git/files and layout tests.
- `node --test tests/runtime-integration/cli-protocol.test.mjs`: CLI protocol checks after building.

Active environment helpers live in `tests/support/`; application fixtures live beside the tests that consume them. Exploratory probes and historical evidence are not part of the published source tree.

The chat subprocess fixture in `tests/e2e/helpers/chat-fixture/provider.mjs` uses native-style protocol messages and temporary history, without changing application storage. `[approve]`, `[hold]` and `[crash]` prompts select permission, interruption and failure scenarios. It proves application behavior with controlled providers, not live account compatibility.
