// mesh-server — HTTP+WS server exposed to the tailnet via the Go sidecar.
//
// Listens on 127.0.0.1 only; the Go sidecar accepts tailnet connections on
// :4242 and io.Copy's them into this loopback port. Routes are under /mesh/*
// to keep them physically separate from the tunnel / visitor-facing /t/*
// routes (see REMOTE_NETWORKING.md §7.3).
//
// Trust model: REMOTE_NETWORKING.md §7.1 — all devices reachable here are
// peers on the same tailnet, i.e. the same user's devices. No per-peer
// application auth. Concurrency limits are generous but still present to
// guard against runaway loops.

import express, { Request, Response, NextFunction } from 'express'
import { createServer, Server as HttpServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import * as os from 'os'
import type { PtyFanout } from './pty-fanout'

const PROTOCOL_VERSION = 1
const MAX_WS_PAYLOAD = 2 * 1024 * 1024
const MAX_WS_CONNECTIONS = 16
const MSG_RATE_WINDOW_MS = 1_000
const MSG_RATE_LIMIT = 500
const WS_PING_INTERVAL = 30_000
const HELLO_ACK_TIMEOUT_MS = 10_000
// How long to treat a peer as "new" after we start listening. First WS within
// this window is considered the first-connect for notification purposes (a
// deliberate v1 simplification — see REMOTE_NETWORKING.md §8.7 where the full
// per-peer identity via WhoIs is deferred).
const FIRST_CONNECT_HEURISTIC_MS = 5_000

export interface MeshTabInfo {
  id: string
  title: string
  kind?: string
  cwd?: string
}

export type TabsProvider = () => MeshTabInfo[]
export type TabCreator = (opts: { cwd?: string; command?: string }) => Promise<MeshTabInfo | null>
export type TabCloser = (tabId: string) => Promise<void>

export type MeshServerEvent =
  | { type: 'peer-connect'; peerId: string; first: boolean }
  | { type: 'peer-disconnect'; peerId: string }
  | { type: 'error'; code: string; message: string }

export class MeshServer {
  private app = express()
  private httpServer: HttpServer | null = null
  private wss: WebSocketServer | null = null
  private pingInterval: ReturnType<typeof setInterval> | null = null

  private port = 0
  private started = false
  private startPromise: Promise<void> | null = null
  private shutdownPromise: Promise<void> | null = null
  private clients = new Set<WebSocket>()
  private clientSubs = new WeakMap<WebSocket, Map<string, () => void>>()
  private listenerStartedAt = 0
  private seenPeers = new Set<string>()

  private tabsProvider: TabsProvider = () => []
  private tabCreator: TabCreator | null = null
  private tabCloser: TabCloser | null = null
  private eventListeners = new Set<(evt: MeshServerEvent) => void>()

  constructor(private readonly fanout: PtyFanout) {
    this.configureApp()
  }

  setTabsProvider(provider: TabsProvider) {
    this.tabsProvider = provider
  }

  setTabCreator(creator: TabCreator | null) {
    this.tabCreator = creator
  }

  setTabCloser(closer: TabCloser | null) {
    this.tabCloser = closer
  }

  onEvent(cb: (evt: MeshServerEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  private emit(evt: MeshServerEvent) {
    for (const l of this.eventListeners) {
      try {
        l(evt)
      } catch {
        // listener errors must not propagate
      }
    }
  }

  private configureApp() {
    this.app.disable('x-powered-by')
    this.app.set('trust proxy', false)

    this.app.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-Frame-Options', 'DENY')
      res.setHeader('Referrer-Policy', 'no-referrer')
      next()
    })

    this.app.get('/mesh/hello', (_req, res) => {
      res.json({ server: 'claude-code-pro', protocol: PROTOCOL_VERSION, supported: [PROTOCOL_VERSION] })
    })

    this.app.get('/mesh/health', (_req, res) => {
      res.json({ ok: true })
    })

    this.app.get('/mesh/tabs', (_req, res) => {
      res.json({ tabs: this.tabsProvider() })
    })
  }

  private async ensureStarted(): Promise<void> {
    if (this.shutdownPromise) await this.shutdownPromise
    if (this.started) return
    if (this.startPromise) return this.startPromise

    this.startPromise = new Promise<void>((resolve, reject) => {
      this.httpServer = createServer(this.app)

      this.wss = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_WS_PAYLOAD,
      })

      this.httpServer.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`)
        if (url.pathname !== '/mesh/ws') {
          socket.destroy()
          return
        }
        if (this.clients.size >= MAX_WS_CONNECTIONS) {
          socket.destroy()
          return
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.attachWs(ws)
        })
      })

      this.pingInterval = setInterval(() => {
        for (const client of this.clients) {
          if (client.readyState === WebSocket.OPEN) {
            try {
              client.ping()
            } catch {
              // ignore
            }
          }
        }
      }, WS_PING_INTERVAL)

      this.httpServer.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address()
        if (addr && typeof addr === 'object') this.port = addr.port
        this.started = true
        this.listenerStartedAt = Date.now()
        resolve()
      })
      this.httpServer.on('error', (err) => reject(err))
    })

    return this.startPromise
  }

  async start(): Promise<number> {
    await this.ensureStarted()
    return this.port
  }

  getPort(): number {
    return this.port
  }

  isStarted(): boolean {
    return this.started
  }

  private attachWs(ws: WebSocket) {
    this.clients.add(ws)
    const subs = new Map<string, () => void>()
    this.clientSubs.set(ws, subs)

    // Peer identity in v1 is just "a connection that arrived". Because the
    // tsnet sidecar io.Copy's to loopback, the remote socket here reports
    // 127.0.0.1 — we can't map it back to a tailnet node name without deeper
    // plumbing. For v1 we use a heuristic (first WS inside
    // FIRST_CONNECT_HEURISTIC_MS after listener start = "new peer") and a
    // simple per-connection id otherwise.
    const peerId = `peer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const isFirst = Date.now() - this.listenerStartedAt < FIRST_CONNECT_HEURISTIC_MS && !this.seenPeers.has(peerId)
    this.seenPeers.add(peerId)
    this.emit({ type: 'peer-connect', peerId, first: isFirst })

    let handshakeDone = false
    let msgCount = 0
    let msgWindowStart = Date.now()

    const send = (obj: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
    }

    send({
      type: 'hello',
      serverVersion: '0.3',
      protocol: PROTOCOL_VERSION,
      supported: [PROTOCOL_VERSION],
      peer: { name: os.hostname(), os: process.platform },
    })

    const helloTimer = setTimeout(() => {
      if (!handshakeDone) {
        send({ type: 'error', code: 'hello_timeout' })
        try {
          ws.close(4003, 'hello_timeout')
        } catch {
          // ignore
        }
      }
    }, HELLO_ACK_TIMEOUT_MS)

    ws.on('message', async (raw) => {
      const now = Date.now()
      if (now - msgWindowStart > MSG_RATE_WINDOW_MS) {
        msgCount = 0
        msgWindowStart = now
      }
      if (++msgCount > MSG_RATE_LIMIT) return

      let m: Record<string, unknown>
      try {
        const parsed = JSON.parse(raw.toString())
        if (!parsed || typeof parsed !== 'object') return
        m = parsed as Record<string, unknown>
      } catch {
        return
      }

      if (m.type === 'hello-ack') {
        if (m.protocol !== PROTOCOL_VERSION) {
          send({ type: 'error', code: 'version_mismatch' })
          try {
            ws.close(4000, 'version_mismatch')
          } catch {
            // ignore
          }
          return
        }
        handshakeDone = true
        clearTimeout(helloTimer)
        return
      }

      if (!handshakeDone) return

      switch (m.type) {
        case 'tabs:list':
          send({ type: 'tabs:list', tabs: this.tabsProvider() })
          return
        case 'tab:subscribe': {
          const tabId = typeof m.tabId === 'string' ? m.tabId : null
          if (!tabId) return
          if (subs.has(tabId)) return // already subscribed
          // Ship history first, then live output.
          const history = this.fanout.buffer.getHistory(tabId)
          send({
            type: 'history',
            tabId,
            data: history.data,
            lastSeq: history.lastSeq,
            truncated: history.truncated,
          })
          const unsub = this.fanout.subscribe(
            tabId,
            (evt) => {
              send({ type: 'output', tabId, seq: evt.seq, data: evt.data })
            },
            (code) => {
              send({ type: 'exit', tabId, code })
            },
          )
          subs.set(tabId, unsub)
          const exit = this.fanout.buffer.getExit(tabId)
          if (exit) send({ type: 'exit', tabId, code: exit.code })
          return
        }
        case 'tab:unsubscribe': {
          const tabId = typeof m.tabId === 'string' ? m.tabId : null
          if (!tabId) return
          const un = subs.get(tabId)
          if (un) {
            un()
            subs.delete(tabId)
          }
          return
        }
        case 'sync': {
          const tabId = typeof m.tabId === 'string' ? m.tabId : null
          if (!tabId) return
          const lastSeq =
            typeof m.lastSeq === 'number' && Number.isFinite(m.lastSeq) ? (m.lastSeq as number) : 0
          if (lastSeq > 0) {
            const delta = this.fanout.buffer.getDelta(tabId, lastSeq)
            if (delta) {
              send({
                type: 'history-delta',
                tabId,
                data: delta.data,
                lastSeq: delta.lastSeq,
                truncated: delta.truncated,
              })
              const exit = this.fanout.buffer.getExit(tabId)
              if (exit) send({ type: 'exit', tabId, code: exit.code })
              return
            }
          }
          const history = this.fanout.buffer.getHistory(tabId)
          send({
            type: 'history',
            tabId,
            data: history.data,
            lastSeq: history.lastSeq,
            truncated: history.truncated,
          })
          const exit = this.fanout.buffer.getExit(tabId)
          if (exit) send({ type: 'exit', tabId, code: exit.code })
          return
        }
        case 'input': {
          const tabId = typeof m.tabId === 'string' ? m.tabId : null
          if (!tabId) return
          if (typeof m.data === 'string' && this.fanout.hasTab(tabId)) {
            this.fanout.write(tabId, m.data)
          }
          return
        }
        case 'resize': {
          // IGNORED in v1. Local renderer is authoritative for PTY size; a
          // remote mesh peer resizing would fight the local terminal size
          // controls. This mirrors the tunnel-side decision.
          return
        }
        case 'tab:new': {
          if (!this.tabCreator) {
            send({ type: 'error', code: 'not_supported', message: 'tab creation unavailable' })
            return
          }
          try {
            const tab = await this.tabCreator({
              cwd: typeof m.cwd === 'string' ? m.cwd : undefined,
              command: typeof m.command === 'string' ? m.command : undefined,
            })
            if (tab) {
              send({ type: 'tab:created', tab })
              this.broadcastTabCreated(tab, ws)
            } else {
              send({ type: 'error', code: 'tab_create_failed', message: 'tab creation returned null' })
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            send({ type: 'error', code: 'tab_create_failed', message: msg })
          }
          return
        }
        case 'tab:close-on-host': {
          const tabId = typeof m.tabId === 'string' ? m.tabId : null
          if (!tabId) return
          if (!this.tabCloser) {
            send({ type: 'error', code: 'not_supported', message: 'tab close-on-host unavailable' })
            return
          }
          try {
            await this.tabCloser(tabId)
            // The fanout exit callback will push 'exit' to subscribers; we
            // additionally send a notification so peers can update their UI
            // even if they weren't subscribed to this tab.
            this.broadcast({ type: 'tab:closed', tabId })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            send({ type: 'error', code: 'tab_close_failed', message: msg })
          }
          return
        }
        default:
          // Unknown type: ignore silently to avoid chatty errors on protocol
          // extensions.
          return
      }
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      for (const un of subs.values()) {
        try {
          un()
        } catch {
          // ignore
        }
      }
      subs.clear()
      this.clients.delete(ws)
      this.emit({ type: 'peer-disconnect', peerId })
    })

    ws.on('error', () => {
      clearTimeout(helloTimer)
      try {
        ws.close()
      } catch {
        // ignore
      }
      this.clients.delete(ws)
    })
  }

  /**
   * Notify all connected peers that a new tab was created locally. Called by
   * main.ts when tab life cycle changes (not just via tab:new — user can
   * open a tab locally and we still want remote peers to see it).
   */
  broadcastTabCreated(tab: MeshTabInfo, exclude?: WebSocket) {
    this.broadcast({ type: 'tab:created', tab }, exclude)
  }

  broadcastTabClosed(tabId: string) {
    this.broadcast({ type: 'tab:closed', tabId })
  }

  private broadcast(obj: unknown, exclude?: WebSocket) {
    const payload = JSON.stringify(obj)
    for (const client of this.clients) {
      if (client === exclude) continue
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload)
        } catch {
          // ignore
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = (async () => {
      if (this.pingInterval) {
        clearInterval(this.pingInterval)
        this.pingInterval = null
      }
      if (this.wss) {
        for (const c of Array.from(this.clients)) {
          try {
            c.close(4001, 'host_disabled')
          } catch {
            // ignore
          }
        }
        this.clients.clear()
        await new Promise<void>((resolve) => this.wss!.close(() => resolve()))
        this.wss = null
      }
      if (this.httpServer) {
        await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()))
        this.httpServer = null
      }
      this.started = false
      this.startPromise = null
      this.port = 0
    })()
    try {
      await this.shutdownPromise
    } finally {
      this.shutdownPromise = null
    }
  }
}
