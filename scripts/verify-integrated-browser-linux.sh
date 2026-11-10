#!/bin/sh
# Official extension + invented existing vault; never opens the host desktop.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "$#" -eq 1 ] || { echo 'Usage: verify-integrated-browser-linux.sh FROZEN_INPUT_DIRECTORY' >&2; exit 2; }
input_dir=$(CDPATH= cd -- "$1" && pwd)
mkdir -p "$repo_dir/artifacts/verification/npm-cache" "$repo_dir/artifacts/verification/electron-cache"
fixture_dir=${COD_TEST_VAULT_DIRECTORY:-$repo_dir/artifacts/bitwarden-fixture}
archive=${COD_TEST_BITWARDEN_ARCHIVE:-$repo_dir/artifacts/bitwarden/bitwarden-2026.10.2.zip}
image_ref=${COD_LINUX_TEST_IMAGE:-cod-test-electron:local}
run_dir=$(mktemp -d "$repo_dir/artifacts/verification/integrated-XXXXXX")
mkdir "$run_dir/integration" "$run_dir/output"
cp "$repo_dir"/tests/support/bitwarden/*.mjs "$repo_dir/tests/support/bitwarden/run.sh" "$run_dir/integration/"
printf 'Isolated official-extension evidence: %s\n' "$run_dir"
set +e
docker run --rm --init --network host --shm-size=1g --cpus=2 --memory=3g --security-opt seccomp=unconfined \
 --mount "type=bind,src=$input_dir,dst=/input,readonly" \
 --mount "type=bind,src=$run_dir/integration,dst=/integration,readonly" \
 --mount "type=bind,src=$run_dir/output,dst=/output" \
 --mount "type=bind,src=$fixture_dir/account.json,dst=/fixture/account.json,readonly" \
 --mount "type=bind,src=$fixture_dir/certs/localhost.crt,dst=/fixture/localhost.crt,readonly" \
 --mount "type=bind,src=$archive,dst=/fixture/extension.zip,readonly" \
 --mount "type=bind,src=$repo_dir/artifacts/verification/electron-cache,dst=/root/.cache/electron" \
 --mount "type=bind,src=$repo_dir/artifacts/verification/npm-cache,dst=/root/.npm" \
 --entrypoint sh "$image_ref" /integration/run.sh > "$run_dir/run.log" 2>&1
result=$?
set -e
cat "$run_dir/run.log"
printf '%s\n' "$result" > "$run_dir/exit-code.txt"
exit "$result"
