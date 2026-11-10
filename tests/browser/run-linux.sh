#!/bin/sh
# Compatibility entry point; all isolated suites use the shared image and runner.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
exec "$repo_dir/scripts/verify-electron-linux.sh" --services browser
