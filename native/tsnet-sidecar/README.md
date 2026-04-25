# tsnet-sidecar

A Go sidecar binary that claude-code-pro spawns to join a Tailscale tailnet
and bridge tailnet TCP traffic to the Node-side mesh server.

See `REMOTE_NETWORKING.md` §3.4 and §4 in the repo root for the architecture
and protocol details. This binary is deliberately minimal: it handles
network-layer concerns (tsnet lifecycle, TCP proxying, SOCKS5 loopback) and
nothing else. All WebSocket/PTY logic lives in the Node side.

## Build

```sh
# Current platform only
go build -ldflags="-s -w" -o build/$(go env GOOS)-$(go env GOARCH)/tsnet-sidecar .

# All 5 supported targets
bash build-all.sh
```

The build drops binaries under `build/<os>-<arch>/tsnet-sidecar[.exe]`. The
Electron packager picks them up via `extraResources`.

## Run (for local testing)

```sh
CC_STATE_DIR=/tmp/tsnet-test CC_HOSTNAME=test-host \
  ./build/linux-amd64/tsnet-sidecar
```

The process prints one JSON object per line on stdout. First line is
`{"type":"ready", "controlPort":N, ...}`. Subsequent lines are state changes,
auth URLs, peer updates. Commands are sent over the control HTTP port
(`POST /up`, `POST /listen?port=N`, etc.).

Exit by sending SIGINT/SIGTERM or closing stdin.
