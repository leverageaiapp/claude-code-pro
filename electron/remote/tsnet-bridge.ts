// tsnet-bridge — Electron main-process wrapper for the Go tsnet sidecar.
//
// Responsibilities:
//   - Locate the prebuilt tsnet-sidecar binary (packaged or dev tree).
//   - Spawn it with the right env vars and stream NDJSON events from stdout.
//   - Expose typed EventEmitter events plus a small Promise-based control API
//     that wraps the sidecar's localhost HTTP endpoints.
//   - Supervise the child process: auto-restart with exponential backoff and
//     surface a 'crashed' event so higher layers can notify the UI.
//
// The bridge never blocks on tailnet connectivity — Up()/Listen() calls are
// fire-and-forget on the sidecar side, and state changes flow back through
// the 'state' / 'peer_update' / 'auth_url' events.

import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import * as path from 'path'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'

export type SidecarState = 'starting' | 'needs_login' | 'running' | 'stopped'

export interface SidecarPeer {
  name: string
  ip: string
  online: boolean
  os?: string
}

export interface SidecarSocks {
  addr: string
  username: string
  password: string
}

export interface SidecarStatus {
  ipnState: SidecarState
  tailnetIp: string
  hostname: string
  hostMode: boolean
  peers: SidecarPeer[]
}

export interface TsnetBridgeOptions {
  stateDir: string
  hostname: string
  controlURL?: string
  // Optional override for tests.
  binaryPathOverride?: string
}

interface ReadyPayload {
  type: 'ready'
  controlPort: number
  meshProxyPort: number
  socksAddr: string
  socksCred: string
}

type StdoutEvent =
  | ReadyPayload
  | { type: 'state'; state: SidecarState; ip?: string }
  | { type: 'auth_url'; url: string }
  | { type: 'peer_update'; peers: SidecarPeer[] }
  | { type: 'error'; message: string }

// Exponential-backoff schedule used when the child process keeps crashing. The
// first few restarts are immediate so transient crashes look snappy; after
// that we stretch out to avoid pathological CPU burn.
const RESTART_DELAYS_MS: number[] = [0, 0, 0, 5_000, 15_000, 60_000, 300_000]
// Once we hit the last entry we stay there.

const READY_TIMEOUT_MS = 10_000

// Default socks username tsnet uses for the SOCKS5 proxy. (From the tsnet
// docs: the returned credential is the password; the username is literally
// "tsnet".)
const SOCKS_USER = 'tsnet'

export class TsnetBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private opts: TsnetBridgeOptions
  private controlPort = 0
  private meshProxyPort = 0
  private socks: SidecarSocks | null = null
  private currentState: SidecarState = 'stopped'
  private tailnetIp = ''
  private peers: SidecarPeer[] = []
  private hostMode = false
  private lastListenPort = 0
  private crashCount = 0
  private shuttingDown = false
  private stdoutBuf = ''
  private readyResolvers: Array<(p: ReadyPayload) => void> = []
  private readyRejecters: Array<(err: Error) => void> = []
  private readyPayload: ReadyPayload | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: TsnetBridgeOptions) {
    super()
    this.opts = opts
  }

  // --- lifecycle ---

  /**
   * Spawn the sidecar and resolve once it emits the ready event. Does not
   * imply tailnet connectivity; call up() after start() to trigger OAuth if
   * needed.
   */
  async start(): Promise<void> {
    if (this.child) return
    this.shuttingDown = false
    const bin = this.resolveBinary()
    if (!bin) {
      const msg = 'tsnet-sidecar binary not found; expected under resources/tsnet-sidecar or native/tsnet-sidecar/build'
      this.emit('error', msg)
      throw new Error(msg)
    }

    // Ensure state dir exists. The sidecar also does this but in Electron we
    // commonly run before the user's profile is fully materialized.
    try {
      fs.mkdirSync(this.opts.stateDir, { recursive: true })
    } catch {
      // ignore — sidecar will re-attempt and fail explicitly if truly broken
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CC_STATE_DIR: this.opts.stateDir,
      CC_HOSTNAME: this.opts.hostname,
    }
    if (this.opts.controlURL) env.CC_CONTROL_URL = this.opts.controlURL

    // windowsHide avoids a flashing cmd window on Windows.
    this.child = spawn(bin, [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    // Sidecar shouldn't use stderr (structured stdout only), but tsnet itself
    // may panic or crash — forward to a debug channel for observability.
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      // We intentionally DO NOT emit or log these; they might contain an
      // auth URL in some edge case. UI layer gets errors via the 'error'
      // event channel.
      void chunk
    })
    this.child.on('exit', (code) => this.onExit(code))
    this.child.on('error', (err) => {
      this.emit('error', `spawn error: ${err.message}`)
    })

    // Wait for the ready event with a bounded timeout.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.readyResolvers.indexOf(resolveOnce)
        if (idx >= 0) this.readyResolvers.splice(idx, 1)
        const idx2 = this.readyRejecters.indexOf(rejectOnce)
        if (idx2 >= 0) this.readyRejecters.splice(idx2, 1)
        reject(new Error('tsnet-sidecar ready timeout'))
      }, READY_TIMEOUT_MS)

      const resolveOnce = (payload: ReadyPayload) => {
        clearTimeout(timeout)
        void payload
        resolve()
      }
      const rejectOnce = (err: Error) => {
        clearTimeout(timeout)
        reject(err)
      }

      this.readyResolvers.push(resolveOnce)
      this.readyRejecters.push(rejectOnce)
    })
  }

  /**
   * Shut down the sidecar cleanly. Idempotent.
   */
  async stop(): Promise<void> {
    this.shuttingDown = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child) return
    try {
      child.stdin.end()
    } catch {
      // ignore
    }
    // Give the sidecar ~2s to exit gracefully (it has a SIGTERM handler), then
    // escalate.
    await new Promise<void>((resolve) => {
      let settled = false
      const onExit = () => {
        if (settled) return
        settled = true
        resolve()
      }
      child.once('exit', onExit)
      setTimeout(() => {
        if (settled) return
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
        setTimeout(onExit, 200)
      }, 2_000)
    })
    this.child = null
  }

  // --- control API (wraps sidecar HTTP) ---

  async up(): Promise<void> {
    await this.control('POST', '/up')
  }

  async down(): Promise<void> {
    // After /down the sidecar closes its tsnet.Server and becomes unusable
    // until respawned. Supervisor here doesn't auto-restart because it was an
    // explicit shutdown — we set shuttingDown and the onExit handler skips
    // the restart.
    this.shuttingDown = true
    try {
      await this.control('POST', '/down')
    } finally {
      this.shuttingDown = false
    }
  }

  async logout(): Promise<void> {
    await this.control('POST', '/logout')
  }

  async enableListen(nodePort: number): Promise<void> {
    if (!Number.isInteger(nodePort) || nodePort <= 0 || nodePort > 65535) {
      throw new Error(`invalid nodePort: ${nodePort}`)
    }
    await this.control('POST', `/listen?port=${nodePort}`)
    this.lastListenPort = nodePort
    this.setHostMode(true)
  }

  async disableListen(): Promise<void> {
    await this.control('POST', '/unlisten')
    this.lastListenPort = 0
    this.setHostMode(false)
  }

  async getStatus(): Promise<SidecarStatus> {
    const raw = await this.control('GET', '/status')
    const parsed = JSON.parse(raw) as SidecarStatus
    this.peers = parsed.peers || []
    if (parsed.tailnetIp) this.tailnetIp = parsed.tailnetIp
    this.hostMode = !!parsed.hostMode
    if (parsed.ipnState) this.currentState = parsed.ipnState
    return parsed
  }

  getCachedStatus(): SidecarStatus {
    return {
      ipnState: this.currentState,
      tailnetIp: this.tailnetIp,
      hostname: this.opts.hostname,
      hostMode: this.hostMode,
      peers: this.peers,
    }
  }

  getSocks(): SidecarSocks | null {
    return this.socks
  }

  getMeshProxyPort(): number {
    return this.meshProxyPort
  }

  isRunning(): boolean {
    return !!this.child
  }

  // --- stdio handling ---

  private onStdout(chunk: string) {
    this.stdoutBuf += chunk
    for (;;) {
      const nl = this.stdoutBuf.indexOf('\n')
      if (nl < 0) break
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line) continue
      let evt: StdoutEvent
      try {
        evt = JSON.parse(line) as StdoutEvent
      } catch {
        // Non-JSON line. Treat as debug noise; don't forward — could contain
        // tsnet log fragments including auth URLs in some edge cases.
        continue
      }
      this.dispatch(evt)
    }
  }

  private dispatch(evt: StdoutEvent) {
    switch (evt.type) {
      case 'ready': {
        this.readyPayload = evt
        this.controlPort = evt.controlPort
        this.meshProxyPort = evt.meshProxyPort
        this.socks = {
          addr: evt.socksAddr,
          username: SOCKS_USER,
          password: evt.socksCred,
        }
        this.crashCount = 0
        this.emit('ready', evt)
        const resolvers = this.readyResolvers.splice(0)
        this.readyRejecters.splice(0)
        for (const r of resolvers) r(evt)
        break
      }
      case 'state': {
        this.currentState = evt.state
        if (evt.ip) this.tailnetIp = evt.ip
        this.emit('state', evt.state, evt.ip || this.tailnetIp)
        break
      }
      case 'auth_url': {
        this.emit('auth_url', evt.url)
        break
      }
      case 'peer_update': {
        this.peers = evt.peers || []
        this.emit('peer_update', this.peers)
        break
      }
      case 'error': {
        this.emit('error', evt.message)
        break
      }
    }
  }

  private onExit(code: number | null) {
    this.child = null
    // Reject any pending ready waiters.
    const rejs = this.readyRejecters.splice(0)
    this.readyResolvers.splice(0)
    for (const r of rejs) r(new Error('tsnet-sidecar exited before ready'))

    if (this.shuttingDown) return
    this.emit('crashed', code)

    this.crashCount++
    const delayIdx = Math.min(this.crashCount - 1, RESTART_DELAYS_MS.length - 1)
    const delay = RESTART_DELAYS_MS[delayIdx]
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      // Re-entrantly start. If start itself fails, onExit will fire again.
      this.start()
        .then(async () => {
          // Best-effort: if we were in host mode, re-enable it so the user
          // doesn't have to toggle after a crash.
          if (this.lastListenPort > 0) {
            try {
              await this.enableListen(this.lastListenPort)
            } catch {
              // will surface via error event
            }
          }
        })
        .catch((err) => {
          this.emit('error', `restart failed: ${err.message || err}`)
        })
    }, delay)
  }

  private setHostMode(on: boolean) {
    if (this.hostMode !== on) {
      this.hostMode = on
      this.emit('host_mode', on)
    }
  }

  // --- HTTP control call ---

  private control(method: 'GET' | 'POST', pathAndQuery: string): Promise<string> {
    if (!this.controlPort) {
      return Promise.reject(new Error('sidecar not ready'))
    }
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.controlPort,
          path: pathAndQuery,
          method,
          timeout: 10_000,
        },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (c) => (body += c))
          res.on('end', () => {
            if (!res.statusCode || res.statusCode >= 400) {
              reject(new Error(`control ${method} ${pathAndQuery} -> ${res.statusCode}: ${body}`))
            } else {
              resolve(body)
            }
          })
        },
      )
      req.on('error', (err) => reject(err))
      req.on('timeout', () => {
        req.destroy(new Error('control request timeout'))
      })
      req.end()
    })
  }

  // --- binary resolution ---

  private resolveBinary(): string | null {
    if (this.opts.binaryPathOverride) {
      return fs.existsSync(this.opts.binaryPathOverride) ? this.opts.binaryPathOverride : null
    }

    const platform = process.platform === 'win32' ? 'windows' : process.platform
    const arch = process.arch
    const suffix = process.platform === 'win32' ? '.exe' : ''

    // electron-builder uses its own os/arch naming: darwin→mac, windows→win,
    // amd64→x64. extraResources copies binaries under that convention, but
    // build-all.sh also publishes under Go-native names for dev/tooling. Try
    // both so the resolver works in packaged AND dev.
    const ebOs = platform === 'darwin' ? 'mac' : platform === 'windows' ? 'win' : platform
    const dirNames = Array.from(new Set([`${platform}-${arch}`, `${ebOs}-${arch}`]))

    // Candidate search order: packaged resources first (production), then
    // source-tree build dir (dev).
    const candidates: string[] = []

    // process.resourcesPath only exists at runtime under Electron; guard with typeof.
    const resourcesPath: string | undefined =
      typeof process !== 'undefined' && (process as unknown as { resourcesPath?: string }).resourcesPath
        ? (process as unknown as { resourcesPath?: string }).resourcesPath
        : undefined
    if (resourcesPath) {
      for (const d of dirNames) {
        candidates.push(path.join(resourcesPath, 'tsnet-sidecar', d, `tsnet-sidecar${suffix}`))
      }
      candidates.push(path.join(resourcesPath, 'tsnet-sidecar', `tsnet-sidecar${suffix}`))
    }

    // Dev tree: electron main is compiled to dist-electron/, so walk up a few
    // levels to find native/.
    const devRoots: string[] = [
      path.resolve(__dirname, '..', '..', 'native'),
      path.resolve(__dirname, '..', '..', '..', 'native'),
      path.resolve(process.cwd(), 'native'),
    ]
    for (const root of devRoots) {
      for (const d of dirNames) {
        candidates.push(path.join(root, 'tsnet-sidecar', 'build', d, `tsnet-sidecar${suffix}`))
      }
    }

    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) {
          // Make sure it's executable on POSIX (extraResources should preserve
          // permissions but we've been bitten before).
          if (process.platform !== 'win32') {
            try {
              fs.chmodSync(c, 0o755)
            } catch {
              // ignore
            }
          }
          return c
        }
      } catch {
        // try next
      }
    }
    return null
  }
}

// Helper for callers that want a typed EventEmitter surface.
export interface TsnetBridgeEvents {
  ready: (payload: ReadyPayload) => void
  state: (state: SidecarState, ip: string) => void
  auth_url: (url: string) => void
  peer_update: (peers: SidecarPeer[]) => void
  crashed: (code: number | null) => void
  error: (msg: string) => void
  host_mode: (enabled: boolean) => void
}

export interface TsnetBridge {
  on<K extends keyof TsnetBridgeEvents>(event: K, listener: TsnetBridgeEvents[K]): this
  off<K extends keyof TsnetBridgeEvents>(event: K, listener: TsnetBridgeEvents[K]): this
  emit<K extends keyof TsnetBridgeEvents>(event: K, ...args: Parameters<TsnetBridgeEvents[K]>): boolean
}

// Default state-dir helper. Keeps OS-specific path discipline out of main.ts.
export function defaultStateDir(userDataDir: string): string {
  return path.join(userDataDir, 'tsnet')
}

// Default hostname helper.
export function defaultHostname(): string {
  const raw = os.hostname().trim().replace(/\s+/g, '-')
  if (!raw) return 'claude-code-pro'
  return `claude-code-pro-${raw}`
}
