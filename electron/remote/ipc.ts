import { ipcMain, BrowserWindow } from 'electron'
import * as path from 'path'
import type { PtyFanout } from './pty-fanout'
import { LocalServer, ShareInfo, ShareEvent } from './local-server'
import { startTunnel, stopTunnel, getTunnelUrl, isTunnelRunning, onTunnelCrash } from './tunnel-manager'

const TUNNEL_IDLE_SHUTDOWN_MS = 5 * 60 * 1_000

export interface RemoteEvent {
  type:
    | 'share:created'
    | 'share:stopped'
    | 'share:client-joined'
    | 'share:client-left'
    | 'tunnel:started'
    | 'tunnel:stopped'
    | 'tunnel:crashed'
  shareId?: string
  tabId?: string
  connectedClients?: number
  tunnelUrl?: string
  code?: number | null
}

export interface RemoteIpcHandles {
  shutdown: () => Promise<void>
  server: LocalServer
}

export function registerRemoteIpc(fanout: PtyFanout, getMainWindow: () => BrowserWindow | null): RemoteIpcHandles {
  // webDir: at runtime the compiled main.js lives under dist-electron/, and we copy web/ next to it
  // (via vite-plugin-electron). For v0 we load directly from the source path — dist-electron is a
  // flat mirror of electron/ because vite-plugin-electron compiles each entry to dist-electron/.
  // The web/ static folder is NOT compiled, so we resolve it relative to __dirname + ../electron/remote/web
  // in dev, and relative to resources in packaged builds. Simplest: resolve from several candidates.
  const webDir = resolveWebDir()

  const server = new LocalServer(fanout, webDir)
  let tunnelShutdownTimer: ReturnType<typeof setTimeout> | null = null

  const emit = (evt: RemoteEvent) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('remote:event', evt)
    }
  }

  const cancelTunnelShutdown = () => {
    if (tunnelShutdownTimer) {
      clearTimeout(tunnelShutdownTimer)
      tunnelShutdownTimer = null
    }
  }

  const scheduleTunnelShutdown = () => {
    cancelTunnelShutdown()
    tunnelShutdownTimer = setTimeout(() => {
      tunnelShutdownTimer = null
      if (!server.hasShares() && isTunnelRunning()) {
        stopTunnel()
        emit({ type: 'tunnel:stopped' })
      }
      if (!server.hasShares()) {
        void server.shutdown()
      }
    }, TUNNEL_IDLE_SHUTDOWN_MS)
  }

  server.onEvent((evt: ShareEvent) => {
    if (evt.type === 'share:client-joined') {
      emit({
        type: 'share:client-joined',
        shareId: evt.shareId,
        tabId: evt.tabId,
        connectedClients: evt.connectedClients,
      })
    } else if (evt.type === 'share:client-left') {
      emit({
        type: 'share:client-left',
        shareId: evt.shareId,
        tabId: evt.tabId,
        connectedClients: evt.connectedClients,
      })
    }
  })

  onTunnelCrash((code) => {
    emit({ type: 'tunnel:crashed', code })
  })

  ipcMain.handle('remote:share:create', async (_event, tabId: string) => {
    if (!fanout.hasTab(tabId)) {
      return { ok: false, error: 'tab_not_found' as const }
    }

    cancelTunnelShutdown()

    const { shareId, token } = await server.createShare(tabId)

    let tunnelUrl = getTunnelUrl()
    if (!tunnelUrl) {
      try {
        tunnelUrl = await startTunnel(server.getPort())
        emit({ type: 'tunnel:started', tunnelUrl })
      } catch (err) {
        server.stopShare(shareId)
        const message = err instanceof Error ? err.message : 'tunnel_start_failed'
        return { ok: false, error: message }
      }
    }

    const url = `${tunnelUrl}/t/${shareId}/?token=${token}`
    emit({ type: 'share:created', shareId, tabId, tunnelUrl })
    return { ok: true, shareId, token, url, tunnelUrl }
  })

  ipcMain.handle('remote:share:stop', async (_event, shareId: string) => {
    const ok = server.stopShare(shareId)
    if (ok) {
      emit({ type: 'share:stopped', shareId })
      if (!server.hasShares()) {
        scheduleTunnelShutdown()
      }
    }
    return ok
  })

  ipcMain.handle('remote:share:list', async () => {
    return {
      shares: server.listShares(),
      tunnelUrl: getTunnelUrl(),
    }
  })

  ipcMain.handle('remote:share:status', async () => {
    return {
      tunnelUrl: getTunnelUrl(),
      cloudflaredRunning: isTunnelRunning(),
      shares: server.listShares() as ShareInfo[],
    }
  })

  const shutdown = async () => {
    cancelTunnelShutdown()
    ipcMain.removeHandler('remote:share:create')
    ipcMain.removeHandler('remote:share:stop')
    ipcMain.removeHandler('remote:share:list')
    ipcMain.removeHandler('remote:share:status')
    await server.stopAllShares()
    if (isTunnelRunning()) {
      stopTunnel()
    }
  }

  return { shutdown, server }
}

function resolveWebDir(): string {
  // Candidates in priority order:
  //  1) Source tree during development (vite-plugin-electron runs main.ts from dist-electron,
  //     but the repo layout lets us find the static files relative to the workspace root).
  //  2) Packaged app: asar unpacked resources under process.resourcesPath.
  //  3) dist-electron sibling (if a build step copies web/ there in future).
  const candidates = [
    path.resolve(__dirname, 'remote', 'web'),
    path.resolve(__dirname, '..', 'dist-electron', 'remote', 'web'),
    path.resolve(__dirname, '..', 'electron', 'remote', 'web'),
    path.resolve(__dirname, '..', '..', 'electron', 'remote', 'web'),
    path.resolve(__dirname, 'web'),
  ]
  // Return the first one that exists; if none found, return the first candidate anyway
  // (LocalServer will respond 500 if index.html is missing, which is the right behavior).
  try {
    const fs = require('fs') as typeof import('fs')
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'index.html'))) return c
    }
  } catch {
    // ignore
  }
  return candidates[0]
}
