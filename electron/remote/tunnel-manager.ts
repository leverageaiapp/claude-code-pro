import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { bin as cloudflaredBin, install as installCloudflared } from 'cloudflared'

let tunnelProcess: ChildProcess | null = null
let tunnelUrl: string | null = null
let crashCallbacks: Array<(code: number | null) => void> = []
let startPromise: Promise<string> | null = null

// Per-process bookkeeping so a stale close/error handler (from a killed proc)
// can't clobber state belonging to its replacement.
const intentionalStops = new WeakSet<ChildProcess>()
const sigkillTimers = new WeakMap<ChildProcess, ReturnType<typeof setTimeout>>()

// In a packaged Electron app, `cloudflaredBin` points at
// .../app.asar/node_modules/cloudflared/bin/cloudflared. asarUnpack
// actually extracts the file to app.asar.unpacked alongside. Electron's
// fs shim pretends the asar path exists, but child_process.spawn bypasses
// that shim and ENOTDIRs when it tries to exec a file that lives inside
// the asar blob. Always prefer the unpacked path if present.
function resolveRealBinary(p: string): string {
  // Handle both slash flavors defensively; on Windows path.sep is '\\' but
  // paths coming through various APIs may be normalized either way.
  return p
    .replace(/([\\/])app\.asar([\\/])/g, '$1app.asar.unpacked$2')
}

async function ensureCloudflared(): Promise<string> {
  const unpacked = resolveRealBinary(cloudflaredBin)

  // Prefer the asar.unpacked location — this is where the packaged app
  // actually stores the binary (see electron-builder asarUnpack config).
  if (fs.existsSync(unpacked)) {
    try { fs.accessSync(unpacked, fs.constants.X_OK) } catch {
      // Best-effort chmod in case extraction didn't preserve the execute bit.
      try { fs.chmodSync(unpacked, 0o755) } catch { /* ignore */ }
    }
    return unpacked
  }

  // Dev / untested fallback: try the original path.
  if (fs.existsSync(cloudflaredBin) && cloudflaredBin === unpacked) {
    // Dev (no asar involved) and the binary already exists.
    return cloudflaredBin
  }

  // Binary missing. Try to install — but install to the *unpacked*
  // location if we're packaged, else to cloudflaredBin directly. Writing
  // inside an asar always fails, so we never install there.
  const installTarget = cloudflaredBin !== unpacked ? unpacked : cloudflaredBin
  try {
    // installCloudflared will mkdir parent dirs as needed.
    await installCloudflared(installTarget)
  } catch (err) {
    throw new Error(
      `cloudflared binary missing and auto-install failed.\n` +
      `  Expected:  ${unpacked}\n` +
      `  Fallback:  ${cloudflaredBin}\n` +
      `  Error:     ${(err as Error).message ?? err}`
    )
  }
  if (fs.existsSync(installTarget)) return installTarget
  // Last-ditch: maybe install wrote to the original path somehow.
  if (fs.existsSync(cloudflaredBin)) return cloudflaredBin
  throw new Error(`cloudflared binary still missing after install attempt at ${installTarget}`)
}

export async function startTunnel(localPort: number): Promise<string> {
  if (tunnelProcess && tunnelUrl) {
    return tunnelUrl
  }
  if (startPromise) {
    return startPromise
  }

  startPromise = (async () => {
    const binPath = await ensureCloudflared()

    return new Promise<string>((resolve, reject) => {
      // Bypass proxies (cloudflared talks to CF edge directly; system proxies cause TLS issues)
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NO_PROXY: '*',
        no_proxy: '*',
      }

      const proc = spawn(binPath, ['tunnel', '--url', `http://localhost:${localPort}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        windowsHide: true,
      })
      tunnelProcess = proc

      let urlFound = false
      const timeout = setTimeout(() => {
        if (!urlFound) {
          reject(new Error('Timeout waiting for cloudflared tunnel URL'))
          stopTunnel()
        }
      }, 30_000)

      const scan = (chunk: Buffer) => {
        const output = chunk.toString()
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
        if (match && !urlFound) {
          urlFound = true
          clearTimeout(timeout)
          tunnelUrl = match[0]
          resolve(tunnelUrl)
        }
      }

      proc.stderr?.on('data', scan)
      proc.stdout?.on('data', scan)

      proc.on('error', (err) => {
        clearTimeout(timeout)
        // Only clear module refs if we're still the current process (a later
        // start may have replaced us; don't clobber its state).
        if (tunnelProcess === proc) {
          tunnelProcess = null
          tunnelUrl = null
        }
        if (!urlFound) reject(err)
      })

      proc.on('close', (code) => {
        const wasIntentional = intentionalStops.has(proc)
        const existingTimer = sigkillTimers.get(proc)
        if (existingTimer) {
          clearTimeout(existingTimer)
          sigkillTimers.delete(proc)
        }
        // Only clear module refs if we're still the current process (a later
        // start may have replaced us; don't clobber its state).
        if (tunnelProcess === proc) {
          tunnelProcess = null
          tunnelUrl = null
        }
        if (!urlFound) {
          clearTimeout(timeout)
          reject(new Error(`cloudflared exited with code ${code}`))
          return
        }
        if (!wasIntentional) {
          for (const cb of crashCallbacks) cb(code)
        }
      })
    })
  })()

  try {
    const url = await startPromise
    startPromise = null
    return url
  } catch (err) {
    startPromise = null
    throw err
  }
}

export function stopTunnel(): void {
  if (tunnelProcess) {
    const proc = tunnelProcess
    intentionalStops.add(proc)
    try {
      proc.kill('SIGTERM')
    } catch {
      // ignore
    }
    // Escalate to SIGKILL if cloudflared ignores SIGTERM. Keyed per-process
    // so it won't affect a newer process if start happens before the timer fires.
    const existingTimer = sigkillTimers.get(proc)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }
    const timer = setTimeout(() => {
      sigkillTimers.delete(proc)
      if (proc.exitCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
    }, 5_000)
    sigkillTimers.set(proc, timer)
    tunnelProcess = null
    tunnelUrl = null
  }
}

export function getTunnelUrl(): string | null {
  return tunnelUrl
}

export function isTunnelRunning(): boolean {
  return tunnelProcess !== null
}

export function onTunnelCrash(cb: (code: number | null) => void): () => void {
  crashCallbacks.push(cb)
  return () => {
    crashCallbacks = crashCallbacks.filter((c) => c !== cb)
  }
}
