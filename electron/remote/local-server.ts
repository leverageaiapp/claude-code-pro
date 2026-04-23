import express, { Request, Response, NextFunction, RequestHandler } from 'express'
import { createServer, IncomingMessage, Server as HttpServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import * as crypto from 'crypto'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { PtyFanout } from './pty-fanout'

const PROTOCOL_VERSION = 1
const MAX_WS_PAYLOAD = 1 * 1024 * 1024
const MAX_CONNECTIONS_PER_SHARE = 10
const MSG_RATE_WINDOW_MS = 1_000
const MSG_RATE_LIMIT = 100
const WS_PING_INTERVAL = 30_000

export interface ShareInfo {
  shareId: string
  tabId: string
  createdAt: number
  connectedClients: number
}

export interface ShareCreated {
  shareId: string
  token: string
}

export type ShareEvent =
  | { type: 'share:client-joined'; shareId: string; tabId: string; connectedClients: number }
  | { type: 'share:client-left'; shareId: string; tabId: string; connectedClients: number }

interface Share {
  shareId: string
  token: string
  tabId: string
  createdAt: number
  connectedClients: Set<WebSocket>
  unsubscribe: () => void
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // still do a constant-time op to avoid length-based early-return as a side channel
    const maxLen = Math.max(a.length, b.length, 1)
    const pa = Buffer.alloc(maxLen)
    const pb = Buffer.alloc(maxLen)
    pa.write(a)
    pb.write(b)
    crypto.timingSafeEqual(pa, pb)
    return false
  }
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return crypto.timingSafeEqual(ab, bb)
}

function parseCookie(header: string, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    if (trimmed.slice(0, eq) === name) {
      const raw = trimmed.slice(eq + 1)
      try {
        return decodeURIComponent(raw)
      } catch {
        // Malformed percent-encoding (e.g. "%GG") — treat cookie as absent
        // rather than letting the URIError bubble up and hang the request.
        return null
      }
    }
  }
  return null
}

export class LocalServer {
  private app = express()
  private httpServer: HttpServer | null = null
  private wss: WebSocketServer | null = null
  private shares = new Map<string, Share>()
  private port = 0
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private started = false
  private startPromise: Promise<void> | null = null
  private eventListeners = new Set<(evt: ShareEvent) => void>()

  constructor(
    private readonly fanout: PtyFanout,
    private readonly webDir: string,
  ) {
    this.configureApp()
  }

  private configureApp() {
    this.app.disable('x-powered-by')
    this.app.set('trust proxy', 1)
    this.app.set('strict routing', true)

    this.app.use((_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-Frame-Options', 'DENY')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' wss: ws: https://cdn.jsdelivr.net; img-src 'self' data:; font-src 'self' data: https://cdn.jsdelivr.net",
      )
      res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()')
      next()
    })

    // Per-share gate: validates the shareId exists, then delegates auth to requireShareAuth.
    const shareGate: RequestHandler = (req, res, next) => {
      const shareId = req.params.shareId
      const share = this.shares.get(shareId)
      if (!share) {
        res.status(404).send('Not found')
        return
      }
      ;(req as Request & { share?: Share }).share = share
      next()
    }

    // Without strict routing, /t/:shareId and /t/:shareId/ would collide. We enforce trailing slash
    // so relative paths in index.html (js/terminal.js etc.) resolve under /t/:shareId/.
    this.app.get('/t/:shareId', (req, res) => {
      const qIdx = req.originalUrl.indexOf('?')
      const suffix = qIdx >= 0 ? req.originalUrl.slice(qIdx) : ''
      res.redirect(302, `/t/${req.params.shareId}/${suffix}`)
    })

    this.app.use('/t/:shareId', shareGate, this.buildShareRouter())
  }

  private buildShareRouter() {
    const router = express.Router({ mergeParams: true })

    const requireShareAuth: RequestHandler = (req, res, next) => {
      const share = (req as Request & { share?: Share }).share!
      const shareId = share.shareId

      const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined
      if (queryToken && safeEqual(queryToken, share.token)) {
        res.cookie(`cc_share_${shareId}`, share.token, {
          httpOnly: true,
          secure: req.protocol === 'https' || req.get('x-forwarded-proto') === 'https',
          sameSite: 'lax',
          path: `/t/${shareId}/`,
        })
        const url = new URL(req.originalUrl, `${req.protocol}://${req.get('host')}`)
        url.searchParams.delete('token')
        res.redirect(302, url.pathname + url.search)
        return
      }

      const cookieVal = parseCookie(req.headers.cookie || '', `cc_share_${shareId}`)
      if (cookieVal && safeEqual(cookieVal, share.token)) {
        next()
        return
      }

      res.status(403).send('Forbidden')
    }

    router.use(requireShareAuth)

    // Serve static assets from web/ under the share scope
    router.use(express.static(this.webDir, { fallthrough: true, index: 'index.html' }))

    router.get('/', (_req, res) => {
      const indexPath = path.join(this.webDir, 'index.html')
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath)
      } else {
        res.status(500).send('Remote share UI assets missing')
      }
    })

    return router
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return
    if (this.startPromise) return this.startPromise

    this.startPromise = new Promise<void>((resolve, reject) => {
      this.httpServer = createServer(this.app)

      this.wss = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_WS_PAYLOAD,
      })

      this.httpServer.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`)
        const match = url.pathname.match(/^\/t\/([^/]+)\/ws\/?$/)
        if (!match) {
          socket.destroy()
          return
        }
        const shareId = match[1]
        const share = this.shares.get(shareId)
        if (!share) {
          socket.destroy()
          return
        }

        const origin = req.headers.origin || ''
        const host = req.headers.host || ''
        if (origin) {
          try {
            if (new URL(origin).host !== host) {
              socket.destroy()
              return
            }
          } catch {
            socket.destroy()
            return
          }
        }

        const cookieVal = parseCookie(req.headers.cookie || '', `cc_share_${shareId}`)
        if (!cookieVal || !safeEqual(cookieVal, share.token)) {
          socket.destroy()
          return
        }

        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.attachWsToShare(ws, share, req)
        })
      })

      this.pingInterval = setInterval(() => {
        this.wss?.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) client.ping()
        })
      }, WS_PING_INTERVAL)

      this.httpServer.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
        }
        this.started = true
        resolve()
      })

      this.httpServer.on('error', (err) => {
        reject(err)
      })
    })

    return this.startPromise
  }

  private emit(evt: ShareEvent) {
    for (const l of this.eventListeners) l(evt)
  }

  onEvent(cb: (evt: ShareEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  private attachWsToShare(ws: WebSocket, share: Share, _req: IncomingMessage) {
    if (share.connectedClients.size >= MAX_CONNECTIONS_PER_SHARE) {
      ws.close(1013, 'Too many connections')
      return
    }

    share.connectedClients.add(ws)
    this.emit({
      type: 'share:client-joined',
      shareId: share.shareId,
      tabId: share.tabId,
      connectedClients: share.connectedClients.size,
    })

    let handshakeDone = false
    let msgCount = 0
    let msgWindowStart = Date.now()

    const send = (obj: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj))
      }
    }

    send({
      type: 'hello',
      serverVersion: '0.1',
      protocol: PROTOCOL_VERSION,
      supported: [PROTOCOL_VERSION],
      peer: { name: os.hostname(), os: process.platform },
    })

    ws.on('message', (data) => {
      const now = Date.now()
      if (now - msgWindowStart > MSG_RATE_WINDOW_MS) {
        msgCount = 0
        msgWindowStart = now
      }
      if (++msgCount > MSG_RATE_LIMIT) return

      let msg: unknown
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      const m = msg as Record<string, unknown>

      if (m.type === 'hello-ack') {
        if (m.protocol !== PROTOCOL_VERSION) {
          send({ type: 'error', code: 'version_mismatch' })
          ws.close(4000, 'version_mismatch')
          return
        }
        handshakeDone = true
        return
      }

      if (!handshakeDone) return

      if (m.type === 'sync') {
        const lastSeqRaw = m.lastSeq
        const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw) ? lastSeqRaw : 0
        if (lastSeq > 0) {
          const delta = this.fanout.buffer.getDelta(share.tabId, lastSeq)
          if (delta) {
            send({ type: 'history-delta', data: delta.data, lastSeq: delta.lastSeq, truncated: delta.truncated })
            return
          }
        }
        const history = this.fanout.buffer.getHistory(share.tabId)
        send({ type: 'history', data: history.data, lastSeq: history.lastSeq, truncated: history.truncated })
        return
      }

      if (m.type === 'input' && typeof m.data === 'string') {
        if (this.fanout.hasTab(share.tabId)) {
          this.fanout.write(share.tabId, m.data)
        }
        return
      }

      if (m.type === 'resize') {
        const cols = Number(m.cols)
        const rows = Number(m.rows)
        if (
          Number.isInteger(cols) &&
          Number.isInteger(rows) &&
          cols > 0 &&
          cols <= 500 &&
          rows > 0 &&
          rows <= 200
        ) {
          // Note: we do NOT resize here. The authoritative size is the local renderer's; resizing
          // from a remote client would fight the local terminal. Safe to ignore for v0.
        }
      }
    })

    ws.on('close', () => {
      share.connectedClients.delete(ws)
      this.emit({
        type: 'share:client-left',
        shareId: share.shareId,
        tabId: share.tabId,
        connectedClients: share.connectedClients.size,
      })
    })

    ws.on('error', () => {
      share.connectedClients.delete(ws)
    })
  }

  async createShare(tabId: string): Promise<ShareCreated> {
    await this.ensureStarted()

    const shareId = crypto.randomBytes(16).toString('hex')
    const token = crypto.randomBytes(16).toString('hex')

    const share: Share = {
      shareId,
      token,
      tabId,
      createdAt: Date.now(),
      connectedClients: new Set(),
      unsubscribe: () => {},
    }

    share.unsubscribe = this.fanout.subscribe(
      tabId,
      (evt) => {
        const payload = JSON.stringify({ type: 'output', seq: evt.seq, data: evt.data })
        for (const client of share.connectedClients) {
          if (client.readyState === WebSocket.OPEN) client.send(payload)
        }
      },
      (code) => {
        const payload = JSON.stringify({ type: 'exit', code })
        for (const client of share.connectedClients) {
          if (client.readyState === WebSocket.OPEN) client.send(payload)
        }
      },
    )

    this.shares.set(shareId, share)
    return { shareId, token }
  }

  stopShare(shareId: string): boolean {
    const share = this.shares.get(shareId)
    if (!share) return false
    try {
      share.unsubscribe()
    } catch {
      // ignore
    }
    for (const client of share.connectedClients) {
      try {
        client.close(4002, 'share_stopped')
      } catch {
        // ignore
      }
    }
    this.shares.delete(shareId)
    return true
  }

  listShares(): ShareInfo[] {
    const out: ShareInfo[] = []
    for (const s of this.shares.values()) {
      out.push({
        shareId: s.shareId,
        tabId: s.tabId,
        createdAt: s.createdAt,
        connectedClients: s.connectedClients.size,
      })
    }
    return out
  }

  hasShares(): boolean {
    return this.shares.size > 0
  }

  getPort(): number {
    return this.port
  }

  isStarted(): boolean {
    return this.started
  }

  async stopAllShares(): Promise<void> {
    for (const id of Array.from(this.shares.keys())) {
      this.stopShare(id)
    }
    await this.shutdown()
  }

  async shutdown(): Promise<void> {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    if (this.wss) {
      for (const c of this.wss.clients) {
        try {
          c.close()
        } catch {
          // ignore
        }
      }
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
  }
}
