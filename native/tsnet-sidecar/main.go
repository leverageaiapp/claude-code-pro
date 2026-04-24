// tsnet-sidecar — Go sidecar for claude-code-pro remote networking.
//
// Architecture: Plan Y from REMOTE_NETWORKING.md §3.4 — this process is a
// "dumb" network layer. It:
//
//   1. Runs a tsnet.Server so the host joins the user's tailnet.
//   2. Optionally listens on a fixed tailnet port (default 4242), io.Copy'ing
//      accepted connections to a Node-managed loopback port (the mesh-server).
//   3. Exposes a loopback SOCKS5 proxy (via tsnet.Server.Loopback) so the Node
//      side can dial other tailnet peers as an outbound WS client.
//   4. Exposes a small localhost-only HTTP control API (status/peers/up/down/
//      listen/unlisten/logout).
//
// All lifecycle events (state changes, OAuth auth URL, peer updates) are
// streamed as single-line JSON objects on stdout — this is the primary IPC
// channel between Electron and this binary. Control operations go over the
// local HTTP port so they can be invoked synchronously from Node.
//
// Crucially: the OAuth login URL is only ever emitted to stdout, never written
// to a file. The parent Electron process is responsible for routing it to the
// system browser.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

const defaultMeshPort = 4242

// Event is the shape of every JSON line written to stdout.
type Event struct {
	Type         string        `json:"type"`
	ControlPort  int           `json:"controlPort,omitempty"`
	MeshProxyPort int          `json:"meshProxyPort,omitempty"`
	SocksAddr    string        `json:"socksAddr,omitempty"`
	SocksCred    string        `json:"socksCred,omitempty"`
	State        string        `json:"state,omitempty"`
	IP           string        `json:"ip,omitempty"`
	URL          string        `json:"url,omitempty"`
	Message      string        `json:"message,omitempty"`
	Peers        []Peer        `json:"peers,omitempty"`
}

// Peer mirrors the subset of tailscale peer metadata the Node side needs.
type Peer struct {
	Name   string `json:"name"`
	IP     string `json:"ip"`
	Online bool   `json:"online"`
	OS     string `json:"os,omitempty"`
}

// Sidecar holds all runtime state. It's effectively a singleton.
type Sidecar struct {
	srv         *tsnet.Server
	hostname    string
	stateDir    string
	controlURL  string

	// stdout writer is serialized through emitMu because multiple goroutines
	// (main, IPN watcher, peer poller) emit events concurrently.
	emitMu sync.Mutex

	// state tracked so /status can respond synchronously even before the
	// first IPN notify arrives.
	mu          sync.RWMutex
	currentState string // "starting", "needs_login", "running", "stopped"
	tailnetIP   string
	peers       []Peer

	// Mesh listener (Host mode). Protected by listenMu.
	listenMu     sync.Mutex
	listener     net.Listener
	listenTarget int // 127.0.0.1:<listenTarget>

	socksAddr string
	socksCred string
}

func main() {
	hostname := os.Getenv("CC_HOSTNAME")
	if hostname == "" {
		h, err := os.Hostname()
		if err != nil || h == "" {
			h = "claude-code-pro"
		} else {
			h = "claude-code-pro-" + h
		}
		hostname = h
	}

	stateDir := os.Getenv("CC_STATE_DIR")
	if stateDir == "" {
		emitErr("CC_STATE_DIR environment variable is required")
		os.Exit(2)
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		emitErr(fmt.Sprintf("failed to create state dir: %v", err))
		os.Exit(2)
	}

	controlURL := os.Getenv("CC_CONTROL_URL")
	authKey := os.Getenv("TS_AUTHKEY")

	sc := &Sidecar{
		hostname:     hostname,
		stateDir:     stateDir,
		controlURL:   controlURL,
		currentState: "starting",
	}

	debugLogs := os.Getenv("CC_DEBUG_LOGS") == "1"
	logf := func(string, ...any) {}
	userLogf := func(format string, args ...any) {}
	if debugLogs {
		logf = func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "[tsnet] "+format+"\n", args...)
		}
		userLogf = func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "[tsnet-user] "+format+"\n", args...)
		}
	}
	sc.srv = &tsnet.Server{
		Hostname:   hostname,
		Dir:        filepath.Clean(stateDir),
		ControlURL: controlURL,
		AuthKey:    authKey,
		Logf:       logf,
		UserLogf:   userLogf,
	}

	// Bring up Control HTTP server (for Node → sidecar commands).
	controlLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		emitErr(fmt.Sprintf("failed to bind control HTTP port: %v", err))
		os.Exit(2)
	}
	controlPort := controlLn.Addr().(*net.TCPAddr).Port

	// Bring up mesh TCP proxy listener (on loopback; real tailnet listener is
	// set up lazily when /listen is called). The "meshProxyPort" in the ready
	// event refers to the tsnet mesh port (fixed 4242) — we expose it as
	// metadata for the Node side.
	meshProxyPort := defaultMeshPort

	// Start the SOCKS5 loopback early so the ready event carries the creds.
	// Loopback() requires the server be started first.
	if err := sc.srv.Start(); err != nil {
		emitErr(fmt.Sprintf("tsnet.Server.Start failed: %v", err))
		os.Exit(2)
	}
	socksAddr, socksCred, _, err := sc.srv.Loopback()
	if err != nil {
		emitErr(fmt.Sprintf("tsnet.Server.Loopback failed: %v", err))
		os.Exit(2)
	}
	sc.socksAddr = socksAddr
	sc.socksCred = socksCred

	// Emit ready event. This is the handshake — Electron blocks on this.
	sc.emit(Event{
		Type:          "ready",
		ControlPort:   controlPort,
		MeshProxyPort: meshProxyPort,
		SocksAddr:     socksAddr,
		SocksCred:     socksCred,
	})

	// Start the IPN bus watcher for state/auth_url events.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go sc.watchIPNBus(ctx)
	go sc.watchPeers(ctx)

	// Kick off Up() in background. Do not block ready emission on it.
	go func() {
		upCtx, upCancel := context.WithTimeout(ctx, 2*time.Minute)
		defer upCancel()
		if _, err := sc.srv.Up(upCtx); err != nil {
			// Up often returns "needs login" style errors on first run. The
			// IPN watcher will pick up the auth URL independently; just log
			// for observability.
			sc.emitError(fmt.Sprintf("tsnet.Server.Up: %v", err))
		}
	}()

	// Start HTTP control server on the pre-bound listener.
	mux := http.NewServeMux()
	sc.registerHandlers(mux)
	httpServer := &http.Server{Handler: mux}
	go func() {
		if err := httpServer.Serve(controlLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			sc.emitError(fmt.Sprintf("control HTTP server: %v", err))
		}
	}()

	// Shutdown triggers: SIGTERM / SIGINT / stdin EOF (parent pipe closed).
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	stdinClosed := make(chan struct{})
	go func() {
		// Reading stdin to EOF is how we detect that Electron closed the pipe
		// (parent died / was killed uncleanly). This gives us a graceful exit
		// even without a signal.
		buf := make([]byte, 256)
		for {
			_, err := os.Stdin.Read(buf)
			if err != nil {
				close(stdinClosed)
				return
			}
		}
	}()

	select {
	case <-sigCh:
	case <-stdinClosed:
	}

	// Graceful shutdown. Close tsnet first so peers see us go offline.
	sc.setState("stopped", "")
	sc.closeListener()
	_ = httpServer.Shutdown(context.Background())
	_ = sc.srv.Close()
	cancel()
}

// --- event emission ---

func (sc *Sidecar) emit(evt Event) {
	sc.emitMu.Lock()
	defer sc.emitMu.Unlock()
	data, err := json.Marshal(evt)
	if err != nil {
		return
	}
	data = append(data, '\n')
	_, _ = os.Stdout.Write(data)
}

func (sc *Sidecar) emitError(msg string) {
	sc.emit(Event{Type: "error", Message: msg})
}

// emitErr is the pre-instance error emitter used during bootstrap.
func emitErr(msg string) {
	data, _ := json.Marshal(Event{Type: "error", Message: msg})
	_, _ = os.Stdout.Write(append(data, '\n'))
}

func (sc *Sidecar) setState(state, ip string) {
	sc.mu.Lock()
	changed := sc.currentState != state || sc.tailnetIP != ip
	sc.currentState = state
	if ip != "" {
		sc.tailnetIP = ip
	}
	sc.mu.Unlock()
	if changed {
		sc.emit(Event{Type: "state", State: state, IP: ip})
	}
}

// --- IPN bus watcher ---

// watchIPNBus subscribes to notifications from the Tailscale local daemon
// embedded in tsnet. We translate the subset we care about (State / BrowseToURL
// / NetMap) into our own stdout event stream. Errors on the bus cause a retry
// with backoff — tsnet takes a moment to spin up its localapi, and transient
// disconnects should not fatal the sidecar.
func (sc *Sidecar) watchIPNBus(ctx context.Context) {
	backoff := 500 * time.Millisecond
	for {
		if ctx.Err() != nil {
			return
		}
		lc, err := sc.srv.LocalClient()
		if err != nil {
			time.Sleep(backoff)
			if backoff < 5*time.Second {
				backoff *= 2
			}
			continue
		}
		watcher, err := lc.WatchIPNBus(ctx, ipn.NotifyInitialState|ipn.NotifyInitialNetMap)
		if err != nil {
			time.Sleep(backoff)
			if backoff < 5*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = 500 * time.Millisecond
		for {
			n, err := watcher.Next()
			if err != nil {
				_ = watcher.Close()
				break
			}
			sc.handleNotify(n)
		}
	}
}

func (sc *Sidecar) handleNotify(n ipn.Notify) {
	if n.BrowseToURL != nil && *n.BrowseToURL != "" {
		sc.emit(Event{Type: "auth_url", URL: *n.BrowseToURL})
	}
	if n.State != nil {
		switch *n.State {
		case ipn.Running:
			sc.setState("running", firstNetMapAddr(n))
		case ipn.Starting:
			sc.setState("starting", "")
		case ipn.NeedsLogin, ipn.NoState:
			sc.setState("needs_login", "")
		case ipn.Stopped:
			sc.setState("stopped", "")
		}
	}
	if n.NetMap != nil {
		if ip := firstNetMapAddr(n); ip != "" {
			sc.mu.Lock()
			sc.tailnetIP = ip
			sc.mu.Unlock()
		}
	}
}

// watchPeers polls status periodically for peer list changes. The IPN bus
// notifies us on NetMap changes too, but running a periodic refresh is
// simpler and keeps the two views from drifting.
func (sc *Sidecar) watchPeers(ctx context.Context) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	var lastKey string
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		peers := sc.collectPeers(ctx)
		sc.mu.Lock()
		sc.peers = peers
		sc.mu.Unlock()
		// Fingerprint so we only emit on actual change.
		key := peersKey(peers)
		if key != lastKey {
			lastKey = key
			sc.emit(Event{Type: "peer_update", Peers: peers})
		}
	}
}

// firstNetMapAddr returns the first tailnet IP of the self node in an IPN
// notify, or "" if none.
func firstNetMapAddr(n ipn.Notify) string {
	if n.NetMap == nil {
		return ""
	}
	addrs := n.NetMap.GetAddresses()
	if addrs.Len() == 0 {
		return ""
	}
	return addrs.At(0).Addr().String()
}

func peersKey(peers []Peer) string {
	b, _ := json.Marshal(peers)
	return string(b)
}

func (sc *Sidecar) collectPeers(ctx context.Context) []Peer {
	lc, err := sc.srv.LocalClient()
	if err != nil {
		return nil
	}
	callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	status, err := lc.Status(callCtx)
	if err != nil || status == nil {
		return nil
	}
	out := make([]Peer, 0, len(status.Peer))
	for _, p := range status.Peer {
		out = append(out, peerFromStatus(p))
	}
	return out
}

func peerFromStatus(p *ipnstate.PeerStatus) Peer {
	ip := ""
	if len(p.TailscaleIPs) > 0 {
		ip = p.TailscaleIPs[0].String()
	}
	return Peer{
		Name:   trimDot(p.HostName),
		IP:     ip,
		Online: p.Online,
		OS:     p.OS,
	}
}

func trimDot(s string) string {
	// DNS names sometimes come back with trailing dot; normalize.
	if len(s) > 0 && s[len(s)-1] == '.' {
		return s[:len(s)-1]
	}
	return s
}

// --- HTTP control API ---

func (sc *Sidecar) registerHandlers(mux *http.ServeMux) {
	mux.HandleFunc("/status", sc.handleStatus)
	mux.HandleFunc("/peers", sc.handlePeers)
	mux.HandleFunc("/up", sc.handleUp)
	mux.HandleFunc("/down", sc.handleDown)
	mux.HandleFunc("/logout", sc.handleLogout)
	mux.HandleFunc("/listen", sc.handleListen)
	mux.HandleFunc("/unlisten", sc.handleUnlisten)
}

func (sc *Sidecar) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	sc.mu.RLock()
	defer sc.mu.RUnlock()
	sc.listenMu.Lock()
	hostMode := sc.listener != nil
	sc.listenMu.Unlock()
	writeJSON(w, map[string]any{
		"ipnState":  sc.currentState,
		"tailnetIp": sc.tailnetIP,
		"hostname":  sc.hostname,
		"hostMode":  hostMode,
		"peers":     sc.peers,
	})
}

func (sc *Sidecar) handlePeers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	peers := sc.collectPeers(ctx)
	sc.mu.Lock()
	sc.peers = peers
	sc.mu.Unlock()
	writeJSON(w, map[string]any{"peers": peers})
}

func (sc *Sidecar) handleUp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Idempotent: Up() on an already-running server is a near no-op.
	go func() {
		upCtx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if _, err := sc.srv.Up(upCtx); err != nil {
			sc.emitError(fmt.Sprintf("Up: %v", err))
		}
	}()
	writeJSON(w, map[string]any{"ok": true})
}

func (sc *Sidecar) handleDown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	sc.closeListener()
	// tsnet.Server doesn't expose a clean Down() that preserves state — the
	// canonical "stop but keep credentials" move is Close(). After Close the
	// Server cannot be restarted in-process, so we flag it and let Electron
	// respawn us if the user wants to come back up. In practice this lines up
	// with the sidecar supervisor logic on the Node side.
	if err := sc.srv.Close(); err != nil {
		sc.emitError(fmt.Sprintf("Close: %v", err))
	}
	sc.setState("stopped", "")
	writeJSON(w, map[string]any{"ok": true})
}

func (sc *Sidecar) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	sc.closeListener()
	_ = sc.srv.Close()
	// Wipe state dir so the next Up() requires a fresh OAuth.
	entries, err := os.ReadDir(sc.stateDir)
	if err == nil {
		for _, e := range entries {
			_ = os.RemoveAll(filepath.Join(sc.stateDir, e.Name()))
		}
	}
	sc.setState("needs_login", "")
	writeJSON(w, map[string]any{"ok": true})
}

func (sc *Sidecar) handleListen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	portStr := r.URL.Query().Get("port")
	if portStr == "" {
		http.Error(w, "missing port", http.StatusBadRequest)
		return
	}
	var port int
	if _, err := fmt.Sscanf(portStr, "%d", &port); err != nil || port <= 0 || port > 65535 {
		http.Error(w, "invalid port", http.StatusBadRequest)
		return
	}

	sc.listenMu.Lock()
	if sc.listener != nil && sc.listenTarget == port {
		// Already listening to same target: no-op.
		sc.listenMu.Unlock()
		writeJSON(w, map[string]any{"ok": true, "already": true})
		return
	}
	// Different target or nothing running: replace.
	if sc.listener != nil {
		_ = sc.listener.Close()
		sc.listener = nil
	}
	ln, err := sc.srv.Listen("tcp", fmt.Sprintf(":%d", defaultMeshPort))
	if err != nil {
		sc.listenMu.Unlock()
		http.Error(w, fmt.Sprintf("listen failed: %v", err), http.StatusInternalServerError)
		return
	}
	sc.listener = ln
	sc.listenTarget = port
	sc.listenMu.Unlock()

	go sc.acceptLoop(ln, port)
	writeJSON(w, map[string]any{"ok": true, "meshPort": defaultMeshPort, "nodePort": port})
}

func (sc *Sidecar) handleUnlisten(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	sc.closeListener()
	writeJSON(w, map[string]any{"ok": true})
}

func (sc *Sidecar) closeListener() {
	sc.listenMu.Lock()
	defer sc.listenMu.Unlock()
	if sc.listener != nil {
		_ = sc.listener.Close()
		sc.listener = nil
		sc.listenTarget = 0
	}
}

// acceptLoop runs until the listener is closed. Each accepted tailnet
// connection is spliced bidirectionally to the Node mesh-server on loopback.
func (sc *Sidecar) acceptLoop(ln net.Listener, nodePort int) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			// Listener closed (either from /unlisten or shutdown). Exit.
			return
		}
		go sc.proxyConn(conn, nodePort)
	}
}

func (sc *Sidecar) proxyConn(remote net.Conn, nodePort int) {
	defer remote.Close()
	local, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", nodePort), 5*time.Second)
	if err != nil {
		sc.emitError(fmt.Sprintf("proxy dial localhost:%d: %v", nodePort, err))
		return
	}
	defer local.Close()

	// Classic bidirectional pipe. Use a WaitGroup so we close fully on either
	// side hanging up.
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _, _ = io.Copy(local, remote); _ = local.(*net.TCPConn).CloseWrite() }()
	go func() { defer wg.Done(); _, _ = io.Copy(remote, local); if rc, ok := remote.(interface{ CloseWrite() error }); ok { _ = rc.CloseWrite() } }()
	wg.Wait()
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
