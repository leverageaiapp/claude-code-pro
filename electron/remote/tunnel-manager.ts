import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import { bin as cloudflaredBin, install as installCloudflared } from 'cloudflared'

let tunnelProcess: ChildProcess | null = null
let tunnelUrl: string | null = null
let crashCallbacks: Array<(code: number | null) => void> = []
let intentionalStop = false

async function ensureCloudflared(): Promise<string> {
  if (fs.existsSync(cloudflaredBin)) {
    return cloudflaredBin
  }
  await installCloudflared(cloudflaredBin)
  return cloudflaredBin
}

export async function startTunnel(localPort: number): Promise<string> {
  if (tunnelProcess && tunnelUrl) {
    return tunnelUrl
  }

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
      if (!urlFound) reject(err)
    })

    proc.on('close', (code) => {
      const wasIntentional = intentionalStop
      tunnelProcess = null
      tunnelUrl = null
      intentionalStop = false
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
}

export function stopTunnel(): void {
  if (tunnelProcess) {
    intentionalStop = true
    try {
      tunnelProcess.kill('SIGTERM')
    } catch {
      // ignore
    }
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
