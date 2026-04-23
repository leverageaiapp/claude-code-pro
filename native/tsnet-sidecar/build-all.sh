#!/usr/bin/env bash
# Cross-compile tsnet-sidecar for all supported targets.
#
# Produces stripped binaries under native/tsnet-sidecar/build/<os>-<arch>/.
# These are picked up by electron-builder via extraResources.

set -euo pipefail

cd "$(dirname "$0")"

TARGETS=(
  "linux amd64"
  "linux arm64"
  "darwin amd64"
  "darwin arm64"
  "windows amd64"
)

# Allow restricting which targets we build via an env var, so CI can skip the
# foreign platforms it doesn't have toolchains for.
if [[ "${SIDECAR_ONLY_CURRENT:-}" == "1" ]]; then
  CURRENT_OS=$(go env GOOS)
  CURRENT_ARCH=$(go env GOARCH)
  TARGETS=("$CURRENT_OS $CURRENT_ARCH")
fi

mkdir -p build

for t in "${TARGETS[@]}"; do
  read -r os arch <<<"$t"
  out_dir="build/${os}-${arch}"
  bin="tsnet-sidecar"
  if [[ "$os" == "windows" ]]; then
    bin="tsnet-sidecar.exe"
  fi
  mkdir -p "$out_dir"
  echo ">> building $os/$arch -> $out_dir/$bin"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
    go build -trimpath -ldflags="-s -w" -o "$out_dir/$bin" .
done

echo "done. artifacts:"
find build -type f \( -name 'tsnet-sidecar' -o -name 'tsnet-sidecar.exe' \) -print
