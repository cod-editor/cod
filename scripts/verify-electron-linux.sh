#!/bin/sh
# Run real Electron acceptance on an isolated virtual display, never the host desktop.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$repo_dir/artifacts/verification/npm-cache"
image_ref=${COD_LINUX_TEST_IMAGE:-cod-test-electron:local}
if ! docker image inspect "$image_ref" >/dev/null 2>&1; then
  echo "Test image unavailable: $image_ref. Build the default with: docker build -t cod-test-electron:local tests/support/electron" >&2
  exit 2
fi
mkdir -p "$repo_dir/artifacts/verification"
mkdir -p "$repo_dir/artifacts/verification/electron-cache"
run_dir=$(mktemp -d "$repo_dir/artifacts/verification/electron-XXXXXX")
mkdir "$run_dir/input" "$run_dir/output"
for input in package.json package-lock.json playwright.config.ts tsconfig.json src scripts tests runtime-skills runtime-plugins assets; do
  (cd "$repo_dir" && tar --exclude='*/artifacts' --exclude='*/node_modules' --exclude='*/test-results' -cf - "$input") | (cd "$run_dir/input" && tar -xf -)
done
cp "$repo_dir/tests/support/electron/run.sh" "$run_dir/input/run-electron.sh"
cp "$repo_dir/tests/support/electron/check-sandbox.mjs" "$run_dir/input/check-sandbox.mjs"
(cd "$run_dir/input" && find . -type f -exec shasum -a 256 '{}' \;) > "$run_dir/input-sha256.txt"
printf 'Frozen input and evidence: %s\n' "$run_dir"
set +e
docker run --rm --init --shm-size=1g --cpus=2 --memory=3g \
  --security-opt seccomp=unconfined \
  --mount "type=bind,src=$run_dir/input,dst=/input,readonly" \
  --mount "type=bind,src=$run_dir/output,dst=/output" \
  --mount "type=bind,src=$repo_dir/artifacts/verification/electron-cache,dst=/root/.cache/electron" \
  --mount "type=bind,src=$repo_dir/artifacts/verification/npm-cache,dst=/root/.npm" \
  --entrypoint sh "$image_ref" /input/run-electron.sh "$@" > "$run_dir/run.log" 2>&1
result=$?
set -e
cat "$run_dir/run.log"
printf '%s\n' "$result" > "$run_dir/exit-code.txt"
exit "$result"
