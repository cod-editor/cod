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
