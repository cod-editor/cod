#!/bin/bash
set -euo pipefail
cd "$(dirname -- "$0")/.."

tag=${1:-}
if [[ $# != 1 || ! "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-preview\.(0|[1-9][0-9]*)$ ]]; then
  echo "Usage: scripts/macos-preview.sh vX.Y.Z-preview.N" >&2
  exit 1
fi
if [[ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]]; then
  echo "This preview requires an Apple Silicon Mac" >&2
  exit 1
fi

version=${tag#v}
name="Cod-$version-macOS-arm64.dmg"
mkdir -p release
stage=$(mktemp -d "$PWD/release/.preview-stage.XXXXXXXX")
mount="$stage/mount"
mkdir "$mount"
mounted=false
cleanup() {
  if [[ "$mounted" == true ]]; then
    hdiutil detach "$mount" >&2 || return
  fi
  rm -rf "$stage"
}
trap cleanup EXIT

package=$(COD_PACKAGE_VERSION="$version" node scripts/package.mjs)
artifact=$(node -p 'JSON.parse(process.argv[1]).artifact' "$package")
mkdir "$stage/image"
ditto "$artifact/Cod.app" "$stage/image/Cod.app"
ln -s /Applications "$stage/image/Applications"
hdiutil create -volname "Cod Preview" -srcfolder "$stage/image" -fs HFS+ -format UDZO "$stage/$name" >&2
hdiutil verify "$stage/$name" >&2
hdiutil attach -readonly -nobrowse -mountpoint "$mount" "$stage/$name" >&2
mounted=true
test "$(readlink "$mount/Applications")" = /Applications
mkdir "$stage/installed"
ditto "$mount/Cod.app" "$stage/installed/Cod.app"
ditto "$artifact/codctl" "$stage/installed/codctl"
node tests/support/electron/check-package.mjs "$stage/installed" "$version" >&2
hdiutil detach "$mount" >&2
mounted=false
mv "$stage/$name" "release/$name"
printf '%s\n' "$name"
