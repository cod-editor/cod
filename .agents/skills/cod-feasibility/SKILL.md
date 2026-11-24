---
name: cod-feasibility
description: Verify an unproven Cod browser, native provider, extension or remote-host integration before depending on it.
---

# Verify an integration

Read `AGENTS.md` and the issue's acceptance. Consult current primary documentation, installed help and source, then use the smallest disposable native probe. Keep profiles and evidence local. Use invented data and a dedicated account when authentication is necessary.

Record exact versions, commands and PASS, FAIL or BLOCKED. A fixture proves Cod behavior, not compatibility with a real provider or extension. Continue independent checks if access is missing. Make the blocker explicit before dependent work.

For official Bitwarden use the pinned archive and disposable local Vaultwarden. The fixtures live in `tests/support/bitwarden`; provision with `prepare-vault.mjs`, its Compose file, `create-account.mjs` and `check-vault.mjs`. Run `scripts/verify-integrated-browser-linux.sh FROZEN_INPUT` using an isolated runner's `input/` directory. Keep certificate exceptions limited to the disposable fixture's SPKI. Never use a personal vault.

For plugin installation and hook policy use `npm run test:integration` with temporary profiles. Preview and back up profile edits. Provider hook trust is a native user action.
