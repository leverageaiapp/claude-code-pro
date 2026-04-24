// mesh-ipc — IPC handlers for the mesh networking feature.
//
// These are registered alongside the existing tunnel IPC but kept in a
// separate file because the lifetimes and dependencies are different: mesh
// owns a long-lived TsnetBridge + MeshServer pair, plus a pool of outbound
// MeshClientSessions indexed by session id.
//
// Channel surface is enumerated in REMOTE_NETWORKING.md and Part E of the
// implementation brief. Everything flows through remote:mesh:* channels;
// renderer subscribes to remote:mesh:event for asynchronous notifications.

import { ipcMain, BrowserWindow, shell } from 'electron'
import { EventEmitter } from 'events'
import * as crypto from 'crypto'
import type { PtyFanout } from './pty-fanout'
import { TsnetBridge, defaultHostname, defaultStateDir, SidecarPeer } from './tsnet-bridge'
import { MeshServer, MeshTabInfo, TabCreator, TabCloser } from './mesh-server'
import {
  MeshClientSession,
  RemoteTabInfo,
  classifyConnectError,
  type ConnectRetryInfo,
} from './mesh-client'

export interface MeshEvent {
  type:
    | 'state'
    | 'auth_url'
    | 'peers'
    | 'host_mode'
    | 'peer_first_connect'
    | 'peer_disconnect'
    | 'remote_tab_exit'
    | 'crashed'
    | 'error'
    | 'connect_retry'
  state?: string
  tailnetIp?: string
  url?: string
  peers?: SidecarPeer[]
  enabled?: boolean
  peerName?: string
  sessionId?: string
  localSessionId?: string
  code?: number | null
  message?: string
  // For 'connect_retry'.
  peerHostname?: string
  attempt?: number
  maxAttempts?: number
  waitMs?: number
}

export interface MeshIpcHandles {
  bridge: TsnetBridge
  server: MeshServer
  shutdown: () => Promise<void>
  setTabsProvider: (provider: () => MeshTabInfo[]) => void
  setTabCreator: (creator: TabCreator | null) => void
  setTabCloser: (closer: TabCloser | null) => void
  notifyTabCreated: (tab: MeshTabInfo) => void
  notifyTabClosed: (tabId: string) => void
}

export interface MeshIpcOptions {
  userDataDir: string
  fanout: PtyFanout
  getMainWindow: () => BrowserWindow | null
  /** Last-saved settings provided by the renderer (optional). */
  initialHostname?: string
  initialControlURL?: string
}

interface PeerSessionEntry {
  id: string
  peerHostname: string
  session: MeshClientSession
  // Map of our own localSessionId -> peer's tabId + unsubscribe fn.
  tabSubs: Map<string, { peerTabId: string; unsub: () => void }>
}

export function registerMeshIpc(opts: MeshIpcOptions): MeshIpcHandles {
  const emitter = new EventEmitter()
  const emit = (evt: MeshEvent) => {
    const win = opts.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('remote:mesh:event', evt)
    }
    emitter.emit('event', evt)
  }

  // Settings held in-memory. Renderer persists device name / custom control
  // URL; this IPC layer just receives them and re-spawns the sidecar on
  // change. The initial values come from whatever main.ts was able to load
  // from disk before we started.
  let hostname = opts.initialHostname || defaultHostname()
  let controlURL = opts.initialControlURL || undefined

  let bridge = buildBridge()
  const server = new MeshServer(opts.fanout)

  // Peer client sessions indexed by an internal sessionId (not the peer's
  // hostname — we might want multiple connections to the same peer).
  const peerSessions = new Map<string, PeerSessionEntry>()
  // Remote-tab pipes: when renderer opens a remote tab we stream incoming
  // output to it via a per-localSessionId IPC channel.
  const localTabPipes = new Map<string, { sessionId: string; peerTabId: string }>()

  function buildBridge(): TsnetBridge {
    const br = new TsnetBridge({
      stateDir: defaultStateDir(opts.userDataDir),
      hostname,
      controlURL,
    })
    wireBridge(br)
    return br
  }

  function wireBridge(br: TsnetBridge) {
    br.on('state', (state: string, ip: string) => {
      emit({ type: 'state', state, tailnetIp: ip })
    })
    br.on('auth_url', (url: string) => {
      // Fire and forget — the UI gets the URL too (so it can show a manual
      // copy fallback) but the common path is opening the system browser.
      try {
        void shell.openExternal(url)
      } catch {
        // ignore
      }
      emit({ type: 'auth_url', url })
    })
    br.on('peer_update', (peers: SidecarPeer[]) => {
      emit({ type: 'peers', peers })
    })
    br.on('host_mode', (enabled: boolean) => {
      emit({ type: 'host_mode', enabled })
    })
    br.on('crashed', (code: number | null) => {
      emit({ type: 'crashed', code })
    })
    br.on('error', (message: string) => {
      emit({ type: 'error', message })
    })
  }

  // Hook mesh-server events back to the renderer.
  server.onEvent((evt) => {
    if (evt.type === 'peer-connect' && evt.first) {
      emit({ type: 'peer_first_connect', peerName: evt.peerId })
    } else if (evt.type === 'error') {
      emit({ type: 'error', message: `${evt.code}: ${evt.message}` })
    }
  })

  // --- IPC handlers ---

  ipcMain.handle('remote:mesh:join', async (_e, args?: { hostname?: string; customControlURL?: string }) => {
    if (args?.hostname && args.hostname.trim()) {
      hostname = args.hostname.trim()
    }
    if (args?.customControlURL !== undefined) {
      controlURL = args.customControlURL.trim() || undefined
    }
    try {
      if (!bridge.isRunning()) {
        await bridge.start()
      }
      await bridge.up()
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit({ type: 'error', message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('remote:mesh:leave', async () => {
    try {
      // Host-mode off first to ensure listener is gone before sidecar stops.
      try {
        await bridge.disableListen()
      } catch {
        // ignore if not running
      }
      await server.shutdown()
      await bridge.stop()
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('remote:mesh:logout', async () => {
    try {
      await bridge.logout()
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('remote:mesh:status', async () => {
    try {
      if (bridge.isRunning()) {
        const s = await bridge.getStatus()
        return { ...s }
      }
    } catch {
      // fall through to cached
    }
    return bridge.getCachedStatus()
  })

  ipcMain.handle('remote:mesh:peers', async () => {
    if (bridge.isRunning()) {
      try {
        const s = await bridge.getStatus()
        return { peers: s.peers }
      } catch {
        // ignore
      }
    }
    return { peers: bridge.getCachedStatus().peers }
  })

  ipcMain.handle('remote:mesh:host:enable', async () => {
    try {
      // Ensure mesh server is up and has a port.
      const port = await server.start()
      await bridge.enableListen(port)
      return { ok: true, port }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('remote:mesh:host:disable', async () => {
    try {
      await bridge.disableListen()
      // We deliberately keep the mesh server HTTP socket bound — it costs ~0
      // and makes re-enabling host mode instantaneous. The tailnet listener
      // is down so no peer can reach it.
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('remote:mesh:setDeviceName', async (_e, name: string) => {
    const trimmed = (name || '').trim()
    if (!trimmed) return { ok: false, error: 'empty name' }
    hostname = trimmed
    return restartSidecar()
  })

  ipcMain.handle('remote:mesh:setCustomControlURL', async (_e, url: string | null | undefined) => {
    const trimmed = (url || '').trim()
    controlURL = trimmed || undefined
    return restartSidecar()
  })

  async function restartSidecar(): Promise<{ ok: boolean; error?: string }> {
    try {
      await bridge.stop()
    } catch {
      // ignore
    }
    bridge = buildBridge()
    try {
      await bridge.start()
      await bridge.up()
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  }

  // --- Outbound peer sessions ---

  ipcMain.handle('remote:mesh:connectPeer', async (_e, peerHostname: string) => {
    const socks = bridge.getSocks()
    if (!socks) return { ok: false, error: 'socks proxy not ready — is sidecar running?' }
    if (!peerHostname || typeof peerHostname !== 'string') {
      return { ok: false, error: 'invalid peerHostname' }
    }
    const sessionId = 'ms-' + crypto.randomBytes(8).toString('hex')
    const session = new MeshClientSession({ peerHostname, socks })
    // Surface in-progress retries so the UI can show "retrying 2/3…" rather
    // than freezing on the Connect button. Subscribed BEFORE connect() so
    // we don't miss the first retry's emit.
    const onRetry = (info: ConnectRetryInfo) => {
      emit({
        type: 'connect_retry',
        peerHostname: info.peerHostname,
        attempt: info.attempt,
        maxAttempts: info.max,
        waitMs: info.waitMs,
      })
    }
    session.on('connect-retry', onRetry)
    try {
      await session.connect()
    } catch (err) {
      session.off('connect-retry', onRetry)
      const cls = classifyConnectError(err, peerHostname)
      return { ok: false, error: cls.userMessage }
    }
    session.off('connect-retry', onRetry)
    session.on('peer-disconnect', () => {
      emit({ type: 'peer_disconnect', sessionId })
    })
    session.on('gave-up', () => {
      emit({ type: 'peer_disconnect', sessionId })
      peerSessions.delete(sessionId)
    })
    session.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err)
      emit({ type: 'error', message, sessionId })
    })
    peerSessions.set(sessionId, {
      id: sessionId,
      peerHostname,
      session,
      tabSubs: new Map(),
    })
    return { ok: true, sessionId }
  })

  ipcMain.handle('remote:mesh:disconnectPeer', async (_e, sessionId: string) => {
    const entry = peerSessions.get(sessionId)
    if (!entry) return { ok: false, error: 'session not found' }
    for (const [, s] of entry.tabSubs) {
      try {
        s.unsub()
      } catch {
        // ignore
      }
    }
    entry.tabSubs.clear()
    try {
      entry.session.close()
    } catch {
      // ignore
    }
    peerSessions.delete(sessionId)
    return { ok: true }
  })

  ipcMain.handle('remote:mesh:listPeerTabs', async (_e, sessionId: string) => {
    const entry = peerSessions.get(sessionId)
    if (!entry) return { ok: false, error: 'session not found' }
    try {
      const tabs = await entry.session.listTabs()
      return { ok: true, tabs }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('remote:mesh:openRemoteTab', async (_e, sessionId: string, peerTabId: string) => {
    const entry = peerSessions.get(sessionId)
    if (!entry) return { ok: false, error: 'session not found' }
    if (!peerTabId) return { ok: false, error: 'invalid peerTabId' }

    const localSessionId = 'rt-' + crypto.randomBytes(8).toString('hex')
    const channel = `remote:mesh:tab:data:${localSessionId}`

    const send = (msg: unknown) => {
      const win = opts.getMainWindow()
      if (win && !win.isDestroyed()) win.webContents.send(channel, msg)
    }

    const unsub = entry.session.subscribe(peerTabId, {
      onHistory: (data, lastSeq, truncated) => {
        send({ type: 'history', data, lastSeq, truncated })
      },
      onOutput: (seq, data) => {
        send({ type: 'output', seq, data })
      },
      onExit: (code) => {
        send({ type: 'exit', code })
        emit({ type: 'remote_tab_exit', localSessionId, code })
      },
      onError: (code, message) => {
        send({ type: 'error', code, message })
      },
    })

    entry.tabSubs.set(localSessionId, { peerTabId, unsub })
    localTabPipes.set(localSessionId, { sessionId, peerTabId })
    return { ok: true, localSessionId }
  })

  ipcMain.handle('remote:mesh:writeRemoteTab', async (_e, localSessionId: string, data: string) => {
    const pipe = localTabPipes.get(localSessionId)
    if (!pipe) return false
    const entry = peerSessions.get(pipe.sessionId)
    if (!entry) return false
    entry.session.write(pipe.peerTabId, data)
    return true
  })

  ipcMain.handle('remote:mesh:closeRemoteTab', async (_e, localSessionId: string) => {
    const pipe = localTabPipes.get(localSessionId)
    if (!pipe) return false
    const entry = peerSessions.get(pipe.sessionId)
    if (entry) {
      const sub = entry.tabSubs.get(localSessionId)
      if (sub) {
        try {
          sub.unsub()
        } catch {
          // ignore
        }
        entry.tabSubs.delete(localSessionId)
      }
    }
    localTabPipes.delete(localSessionId)
    return true
  })

  ipcMain.handle('remote:mesh:killRemoteTab', async (_e, localSessionId: string) => {
    const pipe = localTabPipes.get(localSessionId)
    if (!pipe) return { ok: false, error: 'not found' }
    const entry = peerSessions.get(pipe.sessionId)
    if (!entry) return { ok: false, error: 'session gone' }
    try {
      await entry.session.closeOnHost(pipe.peerTabId)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('remote:mesh:createRemoteTab', async (_e, sessionId: string, args?: { cwd?: string; command?: string }) => {
    const entry = peerSessions.get(sessionId)
    if (!entry) return { ok: false, error: 'session not found' }
    try {
      const tab: RemoteTabInfo = await entry.session.createTab({ cwd: args?.cwd, command: args?.command })
      return { ok: true, tab }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })

  const shutdown = async () => {
    for (const entry of peerSessions.values()) {
      try {
        entry.session.close()
      } catch {
        // ignore
      }
    }
    peerSessions.clear()
    localTabPipes.clear()
    try {
      await server.shutdown()
    } catch {
      // ignore
    }
    try {
      await bridge.stop()
    } catch {
      // ignore
    }
    const channels = [
      'remote:mesh:join',
      'remote:mesh:leave',
      'remote:mesh:logout',
      'remote:mesh:status',
      'remote:mesh:peers',
      'remote:mesh:host:enable',
      'remote:mesh:host:disable',
      'remote:mesh:setDeviceName',
      'remote:mesh:setCustomControlURL',
      'remote:mesh:connectPeer',
      'remote:mesh:disconnectPeer',
      'remote:mesh:listPeerTabs',
      'remote:mesh:openRemoteTab',
      'remote:mesh:writeRemoteTab',
      'remote:mesh:closeRemoteTab',
      'remote:mesh:killRemoteTab',
      'remote:mesh:createRemoteTab',
    ]
    for (const c of channels) {
      try {
        ipcMain.removeHandler(c)
      } catch {
        // ignore
      }
    }
  }

  return {
    bridge,
    server,
    shutdown,
    setTabsProvider: (p) => server.setTabsProvider(p),
    setTabCreator: (c) => server.setTabCreator(c),
    setTabCloser: (c) => server.setTabCloser(c),
    notifyTabCreated: (tab) => server.broadcastTabCreated(tab),
    notifyTabClosed: (tabId) => server.broadcastTabClosed(tabId),
  }
}
