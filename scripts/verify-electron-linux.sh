#!/bin/sh
# Run real Electron acceptance on an isolated virtual display, never the host desktop.
set -eu
freeze_only=false
if [ "${1:-}" = "--freeze-only" ]; then
  freeze_only=true
  shift
fi
full_ci=false
if [ "${1:-}" = "--ci" ]; then
  full_ci=true
  [ "$#" -eq 1 ] || { echo "Full preflight does not accept selected tests" >&2; exit 2; }
fi
repo_dir=$(CDPATH= cd -- "${COD_TEST_SOURCE_DIR:-$(dirname -- "$0")/..}" && pwd)
mkdir -p "$repo_dir/artifacts/verification/npm-cache"
image_ref=${COD_LINUX_TEST_IMAGE:-cod-test-electron:local}
if [ "$freeze_only" = false ] && ! docker image inspect "$image_ref" >/dev/null 2>&1; then
  echo "Test image unavailable: $image_ref. Build the default with: docker build -t cod-test-electron:local tests/support/electron" >&2
  exit 2
fi
mkdir -p "$repo_dir/artifacts/verification"
mkdir -p "$repo_dir/artifacts/verification/electron-cache"
run_dir=$(mktemp -d "$repo_dir/artifacts/verification/electron-XXXXXX")
mkdir "$run_dir/input" "$run_dir/output"
if [ "$full_ci" = true ]; then
  revision=${COD_TEST_FROZEN_REVISION:-}
  if [ -z "$revision" ]; then
    [ -e "$repo_dir/.git" ] || { echo "Full preflight needs a committed Git checkout" >&2; exit 2; }
    [ -z "$(git --no-optional-locks -C "$repo_dir" status --porcelain --untracked-files=normal)" ] || { echo "Commit the final source before full preflight" >&2; exit 2; }
    revision=$(git -C "$repo_dir" rev-parse HEAD)
    git -C "$repo_dir" archive --format=tar "$revision" > "$run_dir/source.tar"
    tar -xf "$run_dir/source.tar" -C "$run_dir/input"
    rm "$run_dir/source.tar"
  else
    (cd "$repo_dir" && tar --exclude='./artifacts' --exclude='./node_modules' --exclude='./.git' -cf - .) | (cd "$run_dir/input" && tar -xf -)
  fi
  case "$revision" in *[!a-f0-9]*|'') echo "Invalid frozen revision" >&2; exit 2;; esac
  printf '{"revision":"%s"}\n' "$revision" > "$run_dir/revision.json"
else
  for input in package.json package-lock.json playwright.config.ts tsconfig.json src scripts tests plugins assets; do
    (cd "$repo_dir" && tar --exclude='*/artifacts' --exclude='*/node_modules' --exclude='*/test-results' --exclude='*/reports' --exclude='*/.git' --exclude='*/.env' --exclude='*/.env.*' -cf - "$input") | (cd "$run_dir/input" && tar -xf -)
  done
  for input in .github .agents AGENTS.md README.md .prettierrc.json .prettierignore .gitignore LICENSE docs; do
    if [ -e "$repo_dir/$input" ]; then
      (cd "$repo_dir" && tar --exclude='docs/meetings' --exclude='*/artifacts' --exclude='*/node_modules' --exclude='*/reports' --exclude='*/.env' --exclude='*/.env.*' -cf - "$input") | (cd "$run_dir/input" && tar -xf -)
    fi
  done
fi
cp "${COD_TEST_RUNNER_FILE:-$repo_dir/tests/support/electron/run.sh}" "$run_dir/input/run-electron.sh"
cp "$repo_dir/tests/support/electron/check-sandbox.mjs" "$run_dir/input/check-sandbox.mjs"
if [ "$full_ci" = true ]; then
  cp "${COD_TEST_PREFLIGHT_DRIVER:-$repo_dir/scripts/ci-preflight.mjs}" "$run_dir/input/run-ci-preflight.mjs"
fi
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$run_dir/input" && find . -type f -exec sha256sum '{}' +) > "$run_dir/input-sha256.txt"
else
  command -v shasum >/dev/null 2>&1 || { echo 'A SHA-256 tool is required' >&2; exit 2; }
  (cd "$run_dir/input" && find . -type f -exec shasum -a 256 '{}' +) > "$run_dir/input-sha256.txt"
fi
printf 'Frozen input and evidence: %s\n' "$run_dir"
if [ "$freeze_only" = true ]; then exit 0; fi
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
if [ "$full_ci" = true ] && [ -z "${COD_TEST_FROZEN_REVISION:-}" ]; then
  source_current=false
  if [ "$(git -C "$repo_dir" rev-parse HEAD)" = "$revision" ] && [ -z "$(git --no-optional-locks -C "$repo_dir" status --porcelain --untracked-files=normal)" ]; then source_current=true; fi
  printf '{"revision":"%s","sourceCurrent":%s}\n' "$revision" "$source_current" > "$run_dir/source-check.json"
  if [ "$source_current" = false ]; then echo "Source changed after full preflight snapshot" >&2; result=1; fi
fi
printf '%s\n' "$result" > "$run_dir/exit-code.txt"
exit "$result"
