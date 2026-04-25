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

# Allow restricting which targets we build via a CLI flag, so CI can skip the
# foreign platforms it doesn't have toolchains for. Flag chosen over env var
# because cmd.exe (Windows npm scripts default shell) can't do `VAR=1 bash …`
# prefix env assignment.
if [[ "${SIDECAR_ONLY_CURRENT:-}" == "1" || "${1:-}" == "--current" ]]; then
  CURRENT_OS=$(go env GOOS)
  CURRENT_ARCH=$(go env GOARCH)
  TARGETS=("$CURRENT_OS $CURRENT_ARCH")
fi

mkdir -p build

# Map Go GOOS/GOARCH to electron-builder's ${os}/${arch} naming so
# extraResources.from = native/tsnet-sidecar/build/${os}-${arch} resolves.
eb_os() {
  case "$1" in
    darwin) echo mac ;;
    windows) echo win ;;
    *) echo "$1" ;;
  esac
}
eb_arch() {
  case "$1" in
    amd64) echo x64 ;;
    *) echo "$1" ;;
  esac
}

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

  # Also publish under the electron-builder naming for extraResources.
  eb_out_dir="build/$(eb_os "$os")-$(eb_arch "$arch")"
  if [[ "$eb_out_dir" != "$out_dir" ]]; then
    mkdir -p "$eb_out_dir"
    cp "$out_dir/$bin" "$eb_out_dir/$bin"
  fi
done

echo "done. artifacts:"
find build -type f \( -name 'tsnet-sidecar' -o -name 'tsnet-sidecar.exe' \) -print
