#!/bin/sh
set -eu
if ! command -v git >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y --no-install-recommends git
fi
mkdir -p /work/app
cp -R /input/. /work/app/
cd /work/app
npm ci --prefer-offline --ignore-scripts --no-audit --no-fund --fetch-timeout=30000 --fetch-retries=1
node node_modules/electron/install.js
chown -R node:node /work /output
chown root:root node_modules/electron/dist/chrome-sandbox
chmod 4755 node_modules/electron/dist/chrome-sandbox
runuser -u node -- npm run typecheck
runuser -u node -- npm run build
runuser -u node -- node --test tests/browser/diagnostics.test.ts tests/keyboard/bindings.test.ts
runuser -u node -- xvfb-run -a node check-sandbox.mjs
if [ "${1:-}" = "--services" ]; then
  shift
  set +e
  runuser -u node -- xvfb-run -a node tests/support/electron/run-services.mjs "$@"
  result=$?
  set -e
  if [ -d artifacts/services ]; then cp -R artifacts/services /output/; fi
  if [ -d artifacts/terminals ]; then cp -R artifacts/terminals /output/; fi
  exit "$result"
fi
# Explicit callers select completed slices; no unimplemented specs run implicitly.
if [ "$#" -eq 0 ]; then
  set -- tests/e2e/workspace-shell.spec.ts tests/e2e/native-chat.spec.ts tests/e2e/terminals.spec.ts tests/e2e/runtime-context.spec.ts tests/e2e/browser.spec.ts tests/e2e/browser-diagnostics.spec.ts tests/e2e/browser-recovery.spec.ts tests/e2e/extension-upgrade.spec.ts tests/e2e/files.spec.ts tests/e2e/reviews.spec.ts tests/e2e/browser-addons.spec.ts tests/e2e/design-journeys.spec.ts tests/e2e/registered-page.spec.ts tests/e2e/attention-status.spec.ts tests/e2e/ui-interactions.spec.ts tests/e2e/navigation-settings.spec.ts tests/e2e/workflow-integrity.spec.ts tests/e2e/keyboard-journeys.spec.ts
fi
exec runuser -u node -- xvfb-run -a ./node_modules/.bin/playwright test "$@" --workers=1 --reporter=list --output=/output/test-results
