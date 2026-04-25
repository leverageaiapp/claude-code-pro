// claude-code-pro shared terminal client
// Server handles token-in-URL -> cookie via redirect, so by the time this script
// runs we are already authenticated via httpOnly cookie.

const PROTOCOL = 1

const darkTheme = {
    background: '#0a0a0a',
    foreground: '#ededed',
    cursor: '#ededed',
    selectionBackground: '#3b82f644'
}

const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Consolas, Monaco, "Courier New", monospace',
    smoothScrollDuration: 120,
    theme: darkTheme,
    scrollback: 10000,
    allowProposedApi: true,
    rescaleOverlappingGlyphs: true,
})

const fitAddon = new FitAddon.FitAddon()
term.loadAddon(fitAddon)
const unicode11Addon = new Unicode11Addon.Unicode11Addon()
term.loadAddon(unicode11Addon)
term.unicode.activeVersion = '11'

term.open(document.getElementById('terminal-container'))
try { fitAddon.fit() } catch {}

const statusDot = document.getElementById('status-dot')

let ws = null
let reconnectAttempts = 0
let reconnectDelay = 500
const MAX_RECONNECT_ATTEMPTS = 10
let lastSeq = 0
let helloAcked = false

function setStatus(state) {
    statusDot.className = ''
    if (state === 'connecting') statusDot.classList.add('connecting')
    else if (state === 'disconnected') statusDot.classList.add('disconnected')
}

function connect() {
    setStatus('connecting')
    helloAcked = false
    // Relative to the current /t/<shareId>/ path — resolves to /t/<shareId>/ws
    const wsUrl = new URL('ws', window.location.href).toString().replace(/^http/, 'ws')
    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
        reconnectAttempts = 0
        reconnectDelay = 500
    }

    ws.onclose = (evt) => {
        setStatus('disconnected')
        ws = null
        if (evt.code === 4000) {
            // version mismatch — don't reconnect
            term.write('\r\n\x1b[31m[Version mismatch — refresh to retry]\x1b[0m\r\n')
            return
        }
        if (evt.code === 4002) {
            term.write('\r\n\x1b[33m[Share stopped by host]\x1b[0m\r\n')
            return
        }
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++
            setTimeout(connect, reconnectDelay)
            reconnectDelay = Math.min(reconnectDelay * 2, 10_000)
        }
    }

    ws.onerror = () => {
        // handled by onclose
    }

    ws.onmessage = (e) => {
        let msg
        try { msg = JSON.parse(e.data) } catch { return }
        if (msg.type === 'hello') {
            if (typeof msg.protocol !== 'number' || msg.protocol !== PROTOCOL) {
                ws.send(JSON.stringify({ type: 'hello-ack', protocol: PROTOCOL, client: { name: 'web', os: 'browser' } }))
                return
            }
            ws.send(JSON.stringify({ type: 'hello-ack', protocol: PROTOCOL, client: { name: 'web', os: 'browser' } }))
            helloAcked = true
            setStatus('connected')
            try { fitAddon.fit() } catch {}
            ws.send(JSON.stringify({ type: 'sync', lastSeq }))
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        } else if (msg.type === 'error') {
            term.write('\r\n\x1b[31m[Error: ' + (msg.code || 'unknown') + ']\x1b[0m\r\n')
        } else if (msg.type === 'output') {
            if (msg.seq != null) lastSeq = msg.seq
            if (typeof msg.data === 'string') term.write(msg.data)
        } else if (msg.type === 'history') {
            if (msg.lastSeq != null) lastSeq = msg.lastSeq
            term.clear()
            if (msg.truncated) {
                term.write('\x1b[90m─── earlier output not retained ───\x1b[0m\r\n')
            }
            if (Array.isArray(msg.data)) msg.data.forEach(d => term.write(d))
        } else if (msg.type === 'history-delta') {
            if (msg.lastSeq != null) lastSeq = msg.lastSeq
            if (Array.isArray(msg.data)) msg.data.forEach(d => term.write(d))
        } else if (msg.type === 'exit') {
            term.write('\r\n\x1b[90m[Process exited, code ' + (msg.code ?? '?') + ']\x1b[0m\r\n')
        }
    }
}

// Forward all xterm-captured input to PTY
term.onData((data) => {
    if (ws && ws.readyState === 1 && helloAcked) {
        ws.send(JSON.stringify({ type: 'input', data }))
    }
})

// Resize handling
let resizeTimeout
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout)
    resizeTimeout = setTimeout(() => {
        try { fitAddon.fit() } catch {}
        if (ws && ws.readyState === 1 && helloAcked) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
    }, 100)
})

term.focus()
connect()
