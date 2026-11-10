#!/bin/sh
set -eu
apt-get update -qq
apt-get install -y --no-install-recommends git unzip
mkdir -p /work/app
cp -R /input/. /work/app/
cd /work/app
mkdir -p artifacts/bitwarden-fixture/certs artifacts/bitwarden tests/support/bitwarden
cp /fixture/account.json artifacts/bitwarden-fixture/account.json
cp /fixture/localhost.crt artifacts/bitwarden-fixture/certs/localhost.crt
cp /fixture/extension.zip artifacts/bitwarden/bitwarden-2026.10.2.zip
cp /integration/*.mjs tests/support/bitwarden/
npm ci --prefer-offline --ignore-scripts --no-audit --no-fund --fetch-timeout=30000 --fetch-retries=1
node node_modules/electron/install.js
chown -R node:node /work /output
chown root:root node_modules/electron/dist/chrome-sandbox
chmod 4755 node_modules/electron/dist/chrome-sandbox
runuser -u node -- npm run build
set +e
runuser -u node -- env COD_TEST_ELECTRON_EXECUTABLE=/work/app/node_modules/electron/dist/electron xvfb-run -a node tests/support/bitwarden/extension-flow.mjs
result=$?
set -e
cp -R artifacts/bitwarden-runs /output/
exit "$result"
