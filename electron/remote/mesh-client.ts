// mesh-client — outbound WebSocket client that connects to another peer's
// mesh-server over the tailnet via the Go sidecar's SOCKS5 loopback.
//
// The Node side never talks to a tailnet IP directly; the sidecar exposes a
// SOCKS5 proxy on 127.0.0.1 that the `ws` client here tunnels through via
// `socks-proxy-agent`. URLs use the peer's tailnet MagicDNS name
// (`claude-code-pro-<host>`) on port 4242 — the sidecar resolves those.
//
// Protocol matches mesh-server.ts: hello / hello-ack, tabs:list, tab:subscribe,
// output, input, etc. Version mismatch surfaces a distinct error code so the UI
// can show a targeted upgrade message (REMOTE_NETWORKING.md §8.6 toast ③).

import WebSocket, { RawData } from 'ws'
import { EventEmitter } from 'events'
import { SocksProxyAgent } from 'socks-proxy-agent'
import * as os from 'os'
import type { SidecarSocks } from './tsnet-bridge'

const PROTOCOL_VERSION = 1
const HELLO_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 15_000
const RECONNECT_MAX_ATTEMPTS = 5
const RECONNECT_BASE_DELAY_MS = 1_000

export interface RemoteTabInfo {
  id: string
  title: string
  kind?: string
  cwd?: string
}

export interface MeshClientOptions {
  peerHostname: string // e.g. "claude-code-pro-jack-mbp"
  peerPort?: number // defaults to 4242
  socks: SidecarSocks
  signal?: AbortSignal
}

export type SubscriptionHandlers = {
  onHistory?: (data: string[], lastSeq: number, truncated: boolean) => void
  onOutput?: (seq: number, data: string) => void
  onExit?: (code: number) => void
  onError?: (code: string, message?: string) => void
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  responseType: string
}

export class MeshClientSession extends EventEmitter {
  private ws: WebSocket | null = null
  private agent: SocksProxyAgent
  private url: string
  private closed = false
  private handshakeResolved = false
  private helloAckSent = false
  private handshakePromise: Promise<void> | null = null
  private subscriptions = new Map<string, SubscriptionHandlers>()
  private pendingReq: PendingRequest | null = null
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private opts: MeshClientOptions

  constructor(opts: MeshClientOptions) {
    super()
    this.opts = opts
    const port = opts.peerPort || 4242
    this.url = `ws://${opts.peerHostname}:${port}/mesh/ws`
    // socks5h:// → let the proxy resolve hostnames. This is important because
    // we want MagicDNS resolution to happen inside the tailnet.
    const socksUrl = `socks5h://${encodeURIComponent(opts.socks.username)}:${encodeURIComponent(opts.socks.password)}@${opts.socks.addr}`
    this.agent = new SocksProxyAgent(socksUrl)
  }

  async connect(): Promise<void> {
    if (this.handshakePromise) return this.handshakePromise
    this.handshakePromise = this.doConnect()
    return this.handshakePromise
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        agent: this.agent,
        // Cap a single frame so a malicious / broken peer can't OOM us.
        maxPayload: 2 * 1024 * 1024,
        handshakeTimeout: HELLO_TIMEOUT_MS,
      })
      this.ws = ws

      const helloTimer = setTimeout(() => {
        reject(new Error('hello_timeout'))
        try {
          ws.close(4003, 'hello_timeout')
        } catch {
          // ignore
        }
      }, HELLO_TIMEOUT_MS)

      ws.on('open', () => {
        // Server sends hello first; we wait for it in onMessage.
      })

      ws.on('message', (raw: RawData) => {
        this.handleMessage(raw, helloTimer, resolve, reject)
      })

      ws.on('error', (err) => {
        clearTimeout(helloTimer)
        if (!this.handshakeResolved) reject(err)
        else this.emit('error', err)
      })

      ws.on('close', (code, reason) => {
        clearTimeout(helloTimer)
        this.ws = null
        if (!this.handshakeResolved) {
          reject(new Error(`ws closed during handshake: ${code} ${reason?.toString() || ''}`))
          return
        }
        this.emit('peer-disconnect', { code, reason: reason?.toString() || '' })
        if (!this.closed) {
          this.scheduleReconnect()
        }
      })

      if (this.opts.signal) {
        const onAbort = () => {
          try {
            ws.close(1000, 'aborted')
          } catch {
            // ignore
          }
          reject(new Error('aborted'))
        }
        if (this.opts.signal.aborted) onAbort()
        else this.opts.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  private handleMessage(
    raw: RawData,
    helloTimer: ReturnType<typeof setTimeout>,
    resolve: () => void,
    reject: (err: Error) => void,
  ) {
    let m: Record<string, unknown>
    try {
      const parsed = JSON.parse(raw.toString())
      if (!parsed || typeof parsed !== 'object') return
      m = parsed as Record<string, unknown>
    } catch {
      return
    }

    if (!this.handshakeResolved) {
      if (m.type === 'hello') {
        if (typeof m.protocol === 'number' && m.protocol !== PROTOCOL_VERSION) {
          clearTimeout(helloTimer)
          reject(new Error('version_mismatch'))
          try {
            this.ws?.close(4000, 'version_mismatch')
          } catch {
            // ignore
          }
          return
        }
        if (!this.helloAckSent) {
          this.helloAckSent = true
          this.send({
            type: 'hello-ack',
            protocol: PROTOCOL_VERSION,
            client: { name: os.hostname(), os: process.platform },
          })
        }
        clearTimeout(helloTimer)
        this.handshakeResolved = true
        this.reconnectAttempts = 0
        resolve()
        // Re-establish any previously active subscriptions on reconnect.
        for (const [tabId] of this.subscriptions) {
          this.send({ type: 'tab:subscribe', tabId })
        }
        return
      }
      if (m.type === 'error' && m.code === 'version_mismatch') {
        clearTimeout(helloTimer)
        reject(new Error('version_mismatch'))
        return
      }
      return
    }

    // Already handshook — route by type.
    this.routeMessage(m)
  }

  private routeMessage(m: Record<string, unknown>) {
    const type = typeof m.type === 'string' ? m.type : ''
    const tabId = typeof m.tabId === 'string' ? m.tabId : undefined

    // Pending request matching.
    if (this.pendingReq && this.pendingReq.responseType === type) {
      clearTimeout(this.pendingReq.timer)
      this.pendingReq.resolve(m)
      this.pendingReq = null
      // Don't return yet — tabs:list also wants to surface to handlers if any.
    }

    if (!tabId) {
      if (type === 'tab:created') this.emit('tab:created', m.tab)
      else if (type === 'tab:closed') this.emit('tab:closed', m.tabId)
      else if (type === 'error') this.emit('error', new Error(`${m.code}: ${m.message || ''}`))
      return
    }

    const handlers = this.subscriptions.get(tabId)
    if (!handlers) return

    switch (type) {
      case 'history':
      case 'history-delta': {
        const data = Array.isArray(m.data) ? (m.data as string[]) : []
        const lastSeq = typeof m.lastSeq === 'number' ? m.lastSeq : 0
        const truncated = !!m.truncated
        handlers.onHistory?.(data, lastSeq, truncated)
        return
      }
      case 'output': {
        const seq = typeof m.seq === 'number' ? m.seq : 0
        const data = typeof m.data === 'string' ? m.data : ''
        handlers.onOutput?.(seq, data)
        return
      }
      case 'exit': {
        const code = typeof m.code === 'number' ? m.code : 0
        handlers.onExit?.(code)
        return
      }
      case 'error': {
        const code = typeof m.code === 'string' ? m.code : 'error'
        const message = typeof m.message === 'string' ? m.message : ''
        handlers.onError?.(code, message)
        return
      }
    }
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
    }
  }

  private async request<T = unknown>(msg: Record<string, unknown>, responseType: string): Promise<T> {
    if (this.pendingReq) {
      // Serialize requests — v1 clients only ever have one in flight.
      await new Promise<void>((r) => setTimeout(r, 5))
      if (this.pendingReq) throw new Error('request already in flight')
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReq = null
        reject(new Error(`request ${msg.type} timeout`))
      }, REQUEST_TIMEOUT_MS)
      this.pendingReq = {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
        responseType,
      }
      this.send(msg)
    })
  }

  async listTabs(): Promise<RemoteTabInfo[]> {
    const res = (await this.request({ type: 'tabs:list' }, 'tabs:list')) as { tabs: RemoteTabInfo[] }
    return res.tabs || []
  }

  subscribe(tabId: string, handlers: SubscriptionHandlers): () => void {
    this.subscriptions.set(tabId, handlers)
    this.send({ type: 'tab:subscribe', tabId })
    return () => {
      this.subscriptions.delete(tabId)
      this.send({ type: 'tab:unsubscribe', tabId })
    }
  }

  write(tabId: string, data: string): void {
    this.send({ type: 'input', tabId, data })
  }

  resync(tabId: string, lastSeq: number): void {
    this.send({ type: 'sync', tabId, lastSeq })
  }

  async createTab(opts: { cwd?: string; command?: string }): Promise<RemoteTabInfo> {
    const res = (await this.request(
      { type: 'tab:new', cwd: opts.cwd, command: opts.command },
      'tab:created',
    )) as { tab: RemoteTabInfo }
    return res.tab
  }

  async closeOnHost(tabId: string): Promise<void> {
    this.send({ type: 'tab:close-on-host', tabId })
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const ws = this.ws
    this.ws = null
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.close(1000, 'client_close')
      } catch {
        // ignore
      }
    }
  }

  private scheduleReconnect() {
    if (this.closed) return
    this.reconnectAttempts++
    if (this.reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
      this.emit('gave-up')
      return
    }
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.handshakeResolved = false
      this.helloAckSent = false
      this.handshakePromise = null
      this.connect().catch((err) => {
        this.emit('error', err)
      })
    }, delay)
  }
}

/**
 * Convenience factory: open and await handshake in one call.
 */
export async function connectMesh(opts: MeshClientOptions): Promise<MeshClientSession> {
  const session = new MeshClientSession(opts)
  await session.connect()
  return session
}
