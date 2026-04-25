import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  RemoteEvent,
  RemoteShareInfo,
  MeshEvent,
  MeshIpnState,
  MeshPeer,
  MeshStatus,
  RemoteTabInfo,
} from '../types'

// v0 tunnel share + v1 tailscale mesh. See REMOTE_NETWORKING.md §8.7 for
// the reference schema; the shape below is a slight evolution that tracks
// what the backend actually emits.

// tsnet-sidecar registers each instance under this hostname prefix
// (see electron/remote/tsnet-bridge.ts defaultHostname). We use it to
// distinguish claude-code-pro devices from the rest of the user's tailnet
// (phones, routers, other servers) — those don't run our mesh-server on
// port 4242, so connecting to them would just ECONNREFUSED.
export const CLAUDE_CODE_PRO_HOSTNAME_PREFIX = 'claude-code-pro-'
export function isClaudeCodePeer(peer: MeshPeer): boolean {
  return peer.name.startsWith(CLAUDE_CODE_PRO_HOSTNAME_PREFIX)
}

export interface Share {
  shareId: string
  tabId: string
  createdAt: number
  connectedClients: number
  // Full URL including token. Only known at creation time (the backend's
  // list() endpoint doesn't return tokens for security), so after an app
  // restart any shares rediscovered from the backend will have url=''.
  url: string
}

interface TunnelState {
  cloudflaredRunning: boolean
  tunnelUrl: string | null
  shares: Share[]
}

// Ephemeral record of an outbound MeshClient session held in the main
// process. We key by sessionId (the backend-minted id) so we can look up
// sessions when a peer tab is opened / closed / disconnected.
export interface MeshSession {
  sessionId: string
  peerHostname: string
  openedAt: number
}

// Per-peer persistent connection state for the sidebar's Remote Hosts UI.
// We keep at most one "host session" per peerHostname so the sidebar can
// show a live list of the host's tabs without reconnecting on every
// expand. Lifecycle: created on first ensurePeerSession, dropped when the
// peer goes offline / the session disconnects / mesh leaves.
export type PeerSessionStatus =
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnected'

export interface PeerSession {
  peerHostname: string
  sessionId: string | null
  status: PeerSessionStatus
  // Live tab list — initialised by ensurePeerSession via listPeerTabs and
  // updated by 'peer_tab_created' / 'peer_tab_closed' events from the host.
  tabs: RemoteTabInfo[]
  error?: string
}

interface MeshState {
  // L1 — user has clicked "Join tailnet" in this app session. Derived from
  // status.ipnState in practice but kept around so the title bar icon
  // doesn't flicker while status is being re-fetched.
  enabled: boolean
  hostMode: boolean
  autoJoinOnStart: boolean
  deviceName: string
  customControlURL: string
  status: MeshIpnState
  tailnetIp: string | null
  // Pending OAuth URL — populated on an `auth_url` event, cleared once
  // the sidecar transitions back to 'running'.
  authUrl: string | null
  peers: MeshPeer[]
  // Peers (by synthetic peer id from `peer_first_connect`) for which the
  // user ticked "Don't show again" on the host-mode toast.
  trustedPeers: string[]
  // In-memory outbound sessions. Plain object for easy serialization /
  // reactivity in Zustand (Map is awkward under structural updates).
  activeSessions: Record<string, MeshSession>
  // Persistent per-host sessions used by the sidebar Remote Hosts list.
  // Keyed by peerHostname so the UI can look up by the stable identifier
  // it already has in `peers`. Distinct from `activeSessions` (which is
  // keyed by ephemeral sessionId) so RemoteModal's existing flows keep
  // working unchanged.
  peerSessions: Record<string, PeerSession>
}

interface ToastState {
  // Persisted — once the user dismisses this toast with "don't show again" it
  // stays dismissed.
  remoteTabCloseMuted: boolean
}

// Non-persisted UI state: transient toasts surfaced to the user from
// backend events. Consumed by the <ToastStack /> in App.tsx and cleared
// on dismiss. Don't persist — the events that produced them don't survive
// restart either.
export interface ToastMessage {
  id: string
  kind:
    | 'peer-first-connect'
    | 'remote-tab-closed'
    | 'version-mismatch'
    | 'reconnecting'
    | 'info'
    | 'error'
  title: string
  body?: string
  // Optional context for interactive toasts — `peer-first-connect` uses
  // `peerName` to let the user mute future toasts for that peer.
  peerName?: string
  createdAt: number
  // Auto-dismiss after N ms. Omit for sticky toasts.
  ttlMs?: number
}

interface RemoteState {
  tunnel: TunnelState
  mesh: MeshState
  toasts: ToastState
  toastQueue: ToastMessage[]

  // --- tunnel actions ---
  refreshStatus: () => Promise<void>
  createShare: (tabId: string) => Promise<{ ok: boolean; url?: string; error?: string }>
  stopShare: (shareId: string) => Promise<void>
  setRemoteTabCloseMuted: (v: boolean) => void

  // --- mesh actions ---
  refreshMeshStatus: () => Promise<void>
  joinMesh: () => Promise<{ ok: boolean; error?: string }>
  leaveMesh: () => Promise<{ ok: boolean; error?: string }>
  logoutMesh: () => Promise<{ ok: boolean; error?: string }>
  enableHost: () => Promise<{ ok: boolean; error?: string }>
  disableHost: () => Promise<{ ok: boolean; error?: string }>
  setDeviceName: (name: string) => Promise<{ ok: boolean; error?: string }>
  setCustomControlURL: (url: string) => Promise<{ ok: boolean; error?: string }>
  setAutoJoinOnStart: (v: boolean) => void
  revokeAllRemoteAccess: () => Promise<void>

  // outbound peer sessions
  connectToPeer: (
    peerHostname: string,
  ) => Promise<{ ok: boolean; sessionId?: string; error?: string }>
  disconnectFromPeer: (sessionId: string) => Promise<void>
  listPeerTabs: (
    sessionId: string,
  ) => Promise<{ ok: boolean; tabs?: RemoteTabInfo[]; error?: string }>
  openRemoteTab: (
    sessionId: string,
    peerTabId: string,
  ) => Promise<{ ok: boolean; localSessionId?: string; error?: string }>
  closeRemoteTab: (localSessionId: string) => Promise<void>
  killRemoteTab: (localSessionId: string) => Promise<{ ok: boolean; error?: string }>

  // persistent per-host sessions (sidebar)
  ensurePeerSession: (peerHostname: string) => Promise<PeerSession>
  refreshPeerTabs: (peerHostname: string) => Promise<void>
  createTabOnPeer: (
    peerHostname: string,
    args?: { cwd?: string; command?: string },
  ) => Promise<{ ok: boolean; tab?: RemoteTabInfo; error?: string }>

  // trust / toasts
  markPeerTrusted: (peerName: string) => void
  pushToast: (t: Omit<ToastMessage, 'id' | 'createdAt'>) => void
  dismissToast: (id: string) => void
}

const initialTunnel: TunnelState = {
  cloudflaredRunning: false,
  tunnelUrl: null,
  shares: [],
}

const initialMesh: MeshState = {
  enabled: false,
  hostMode: false,
  autoJoinOnStart: false,
  deviceName: '',
  customControlURL: '',
  status: 'stopped',
  tailnetIp: null,
  authUrl: null,
  peers: [],
  trustedPeers: [],
  activeSessions: {},
  peerSessions: {},
}

let toastCounter = 0
function genToastId() {
  return `toast-${Date.now()}-${++toastCounter}`
}

function applyShareInfo(existing: Share[], infos: RemoteShareInfo[]): Share[] {
  // Preserve any in-memory url/token we already have for a share (they're
  // only known at creation time). Backend-only shares come through with
  // url=''.
  return infos.map((info) => {
    const prior = existing.find((s) => s.shareId === info.shareId)
    return {
      shareId: info.shareId,
      tabId: info.tabId,
      createdAt: info.createdAt,
      connectedClients: info.connectedClients,
      url: prior?.url ?? '',
    }
  })
}

export const useRemoteStore = create<RemoteState>()(
  persist(
    (set, get) => ({
      tunnel: initialTunnel,
      mesh: initialMesh,
      toasts: { remoteTabCloseMuted: false },
      toastQueue: [],

      refreshStatus: async () => {
        const status = await window.electronAPI.remote.share.status()
        set((state) => ({
          tunnel: {
            cloudflaredRunning: status.cloudflaredRunning,
            tunnelUrl: status.tunnelUrl,
            shares: applyShareInfo(state.tunnel.shares, status.shares),
          },
        }))
      },

      createShare: async (tabId: string) => {
        const res = await window.electronAPI.remote.share.create(tabId)
        if (!res.ok) {
          return { ok: false, error: res.error }
        }
        const share: Share = {
          shareId: res.shareId,
          tabId,
          createdAt: Date.now(),
          connectedClients: 0,
          url: res.url,
        }
        set((state) => {
          // If an event raced us, don't double-insert.
          const already = state.tunnel.shares.some((s) => s.shareId === share.shareId)
          const shares = already
            ? state.tunnel.shares.map((s) =>
                s.shareId === share.shareId ? { ...s, url: share.url } : s
              )
            : [...state.tunnel.shares, share]
          return {
            tunnel: {
              ...state.tunnel,
              tunnelUrl: res.tunnelUrl || state.tunnel.tunnelUrl,
              cloudflaredRunning: true,
              shares,
            },
          }
        })
        return { ok: true, url: res.url }
      },

      stopShare: async (shareId: string) => {
        await window.electronAPI.remote.share.stop(shareId)
        // We rely on the `share:stopped` event to remove it from state,
        // but also do an optimistic removal so the UI feels responsive if
        // the event is delayed.
        set((state) => ({
          tunnel: {
            ...state.tunnel,
            shares: state.tunnel.shares.filter((s) => s.shareId !== shareId),
          },
        }))
      },

      setRemoteTabCloseMuted: (v) =>
        set((state) => ({ toasts: { ...state.toasts, remoteTabCloseMuted: v } })),

      // --- mesh actions ---

      refreshMeshStatus: async () => {
        try {
          const status: MeshStatus = await window.electronAPI.remote.mesh.status()
          set((state) => ({
            mesh: {
              ...state.mesh,
              status: status.ipnState,
              tailnetIp: status.tailnetIp || null,
              hostMode: status.hostMode,
              peers: status.peers ?? [],
              deviceName: state.mesh.deviceName || status.hostname || '',
              enabled:
                state.mesh.enabled ||
                status.ipnState === 'running' ||
                status.ipnState === 'starting' ||
                status.ipnState === 'needs_login',
            },
          }))
        } catch {
          // backend not ready yet — leave cached state.
        }
      },

      joinMesh: async () => {
        const { deviceName, customControlURL } = get().mesh
        set((state) => ({
          mesh: { ...state.mesh, enabled: true, status: 'starting', authUrl: null },
        }))
        const res = await window.electronAPI.remote.mesh.join({
          hostname: deviceName || undefined,
          customControlURL: customControlURL || undefined,
        })
        if (!res.ok) {
          set((state) => ({
            mesh: { ...state.mesh, enabled: false, status: 'stopped' },
          }))
        }
        // Refresh to pick up updated ipnState / tailnetIp.
        void get().refreshMeshStatus()
        return res
      },

      leaveMesh: async () => {
        const res = await window.electronAPI.remote.mesh.leave()
        set((state) => ({
          mesh: {
            ...state.mesh,
            enabled: false,
            hostMode: false,
            status: 'stopped',
            tailnetIp: null,
            authUrl: null,
            peers: [],
            activeSessions: {},
            peerSessions: {},
          },
        }))
        return res
      },

      logoutMesh: async () => {
        const res = await window.electronAPI.remote.mesh.logout()
        // logout forces re-auth on next join; treat as leave for UI state.
        set((state) => ({
          mesh: {
            ...state.mesh,
            enabled: false,
            hostMode: false,
            status: 'stopped',
            tailnetIp: null,
            authUrl: null,
          },
        }))
        return res
      },

      enableHost: async () => {
        const res = await window.electronAPI.remote.mesh.hostEnable()
        if (res.ok) {
          set((state) => ({ mesh: { ...state.mesh, hostMode: true } }))
        }
        return { ok: res.ok, error: res.error }
      },

      disableHost: async () => {
        const res = await window.electronAPI.remote.mesh.hostDisable()
        if (res.ok) {
          set((state) => ({ mesh: { ...state.mesh, hostMode: false } }))
        }
        return res
      },

      setDeviceName: async (name: string) => {
        set((state) => ({ mesh: { ...state.mesh, deviceName: name } }))
        // The backend restarts the sidecar; in a freshly-started app where
        // the user has not yet joined we skip the IPC call and just
        // remember the name for next join.
        if (!get().mesh.enabled) return { ok: true }
        return window.electronAPI.remote.mesh.setDeviceName(name)
      },

      setCustomControlURL: async (url: string) => {
        set((state) => ({ mesh: { ...state.mesh, customControlURL: url } }))
        if (!get().mesh.enabled) return { ok: true }
        return window.electronAPI.remote.mesh.setCustomControlURL(url || null)
      },

      setAutoJoinOnStart: (v: boolean) =>
        set((state) => ({ mesh: { ...state.mesh, autoJoinOnStart: v } })),

      revokeAllRemoteAccess: async () => {
        // 1) Disable host mode (stops accepting new connections).
        try {
          await window.electronAPI.remote.mesh.hostDisable()
        } catch {
          // ignore
        }
        // 2) Disconnect every outbound session.
        const sessions = Object.values(get().mesh.activeSessions)
        for (const s of sessions) {
          try {
            await window.electronAPI.remote.mesh.disconnectPeer(s.sessionId)
          } catch {
            // ignore
          }
        }
        // 3) Leave the tailnet entirely.
        try {
          await window.electronAPI.remote.mesh.leave()
        } catch {
          // ignore
        }
        set((state) => ({
          mesh: {
            ...state.mesh,
            enabled: false,
            hostMode: false,
            status: 'stopped',
            tailnetIp: null,
            peers: [],
            activeSessions: {},
            peerSessions: {},
          },
        }))
      },

      connectToPeer: async (peerHostname: string) => {
        const res = await window.electronAPI.remote.mesh.connectPeer(peerHostname)
        if (res.ok && res.sessionId) {
          const session: MeshSession = {
            sessionId: res.sessionId,
            peerHostname,
            openedAt: Date.now(),
          }
          set((state) => ({
            mesh: {
              ...state.mesh,
              activeSessions: { ...state.mesh.activeSessions, [res.sessionId!]: session },
            },
          }))
        }
        return res
      },

      disconnectFromPeer: async (sessionId: string) => {
        try {
          await window.electronAPI.remote.mesh.disconnectPeer(sessionId)
        } catch {
          // ignore
        }
        set((state) => {
          const next = { ...state.mesh.activeSessions }
          delete next[sessionId]
          return { mesh: { ...state.mesh, activeSessions: next } }
        })
      },

      listPeerTabs: async (sessionId: string) =>
        window.electronAPI.remote.mesh.listPeerTabs(sessionId),

      openRemoteTab: async (sessionId: string, peerTabId: string) =>
        window.electronAPI.remote.mesh.openRemoteTab(sessionId, peerTabId),

      closeRemoteTab: async (localSessionId: string) => {
        try {
          await window.electronAPI.remote.mesh.closeRemoteTab(localSessionId)
        } catch {
          // ignore
        }
      },

      killRemoteTab: async (localSessionId: string) =>
        window.electronAPI.remote.mesh.killRemoteTab(localSessionId),

      // --- persistent per-host sessions (sidebar Remote Hosts) ---

      ensurePeerSession: async (peerHostname: string) => {
        // Bail if mesh has been left between the user's click and our
        // first set — otherwise the writes below would resurrect a phantom
        // entry under mesh.enabled=false.
        if (!get().mesh.enabled) {
          return {
            peerHostname,
            sessionId: null,
            status: 'error' as const,
            tabs: [],
            error: 'mesh is not enabled',
          }
        }
        const existing = get().mesh.peerSessions[peerHostname]
        // Idempotent: return any non-failed in-progress / live session.
        // If a previous attempt failed or got disconnected we retry below
        // (the user re-expanding the row is treated as "try again").
        if (
          existing &&
          (existing.status === 'connecting' || existing.status === 'connected')
        ) {
          return existing
        }
        const initial: PeerSession = {
          peerHostname,
          sessionId: null,
          status: 'connecting',
          tabs: [],
        }
        set((state) => ({
          mesh: {
            ...state.mesh,
            peerSessions: { ...state.mesh.peerSessions, [peerHostname]: initial },
          },
        }))
        // Helper: write only if our 'connecting' marker is still present.
        // If something cleared it (leaveMesh / peers offline / a parallel
        // ensurePeerSession that already raced ahead) we drop the result on
        // the floor rather than resurrecting a stale entry.
        const settle = (entry: PeerSession): boolean => {
          let written = false
          set((state) => {
            const cur = state.mesh.peerSessions[peerHostname]
            if (!cur || cur.status !== 'connecting') return state
            written = true
            return {
              mesh: {
                ...state.mesh,
                peerSessions: { ...state.mesh.peerSessions, [peerHostname]: entry },
              },
            }
          })
          return written
        }
        const connRes = await get().connectToPeer(peerHostname)
        if (!connRes.ok || !connRes.sessionId) {
          const failed: PeerSession = {
            peerHostname,
            sessionId: null,
            status: 'error',
            tabs: [],
            error: connRes.error,
          }
          settle(failed)
          return failed
        }
        const sessionId = connRes.sessionId
        const tabsRes = await get().listPeerTabs(sessionId)
        const tabs = tabsRes.ok ? tabsRes.tabs ?? [] : []
        const next: PeerSession = {
          peerHostname,
          sessionId,
          status: tabsRes.ok ? 'connected' : 'error',
          tabs,
          error: tabsRes.ok ? undefined : tabsRes.error,
        }
        const written = settle(next)
        if (!written) {
          // Our entry was removed during the await — the caller's session
          // is now unreferenced. Tear it down so the underlying
          // MeshClientSession doesn't leak.
          void window.electronAPI.remote.mesh.disconnectPeer(sessionId)
        }
        return next
      },

      refreshPeerTabs: async (peerHostname: string) => {
        const entry = get().mesh.peerSessions[peerHostname]
        if (!entry?.sessionId || entry.status !== 'connected') return
        const res = await get().listPeerTabs(entry.sessionId)
        if (!res.ok) return
        set((state) => {
          const cur = state.mesh.peerSessions[peerHostname]
          if (!cur || cur.sessionId !== entry.sessionId) return state
          return {
            mesh: {
              ...state.mesh,
              peerSessions: {
                ...state.mesh.peerSessions,
                [peerHostname]: { ...cur, tabs: res.tabs ?? [] },
              },
            },
          }
        })
      },

      createTabOnPeer: async (peerHostname, args) => {
        const entry = await get().ensurePeerSession(peerHostname)
        if (entry.status !== 'connected' || !entry.sessionId) {
          return { ok: false, error: entry.error || 'peer not connected' }
        }
        const res = await window.electronAPI.remote.mesh.createRemoteTab(
          entry.sessionId,
          args,
        )
        if (res.ok && res.tab) {
          // Optimistically merge. mesh-client.ts emits 'tab:created' even
          // for the requester (the response message is the source for both
          // the resolved request AND the event), so peer_tab_created will
          // also fire shortly with the same tab. The de-dup below makes
          // both paths converge; we keep the optimistic merge so the UI
          // doesn't blink between "create returned" and "event arrived".
          set((state) => {
            const cur = state.mesh.peerSessions[peerHostname]
            if (!cur) return state
            const already = cur.tabs.some((t) => t.id === res.tab!.id)
            if (already) return state
            return {
              mesh: {
                ...state.mesh,
                peerSessions: {
                  ...state.mesh.peerSessions,
                  [peerHostname]: { ...cur, tabs: [...cur.tabs, res.tab!] },
                },
              },
            }
          })
        }
        return res
      },

      markPeerTrusted: (peerName: string) =>
        set((state) => {
          if (state.mesh.trustedPeers.includes(peerName)) return state
          return {
            mesh: {
              ...state.mesh,
              trustedPeers: [...state.mesh.trustedPeers, peerName],
            },
          }
        }),

      pushToast: (t) => {
        const id = genToastId()
        const msg: ToastMessage = { ...t, id, createdAt: Date.now() }
        set((state) => ({ toastQueue: [...state.toastQueue, msg] }))
        if (msg.ttlMs && msg.ttlMs > 0) {
          window.setTimeout(() => {
            const store = useRemoteStore.getState()
            store.dismissToast(id)
          }, msg.ttlMs)
        }
      },

      dismissToast: (id: string) =>
        set((state) => ({ toastQueue: state.toastQueue.filter((t) => t.id !== id) })),
    }),
    {
      name: 'claude-code-pro:remote',
      storage: createJSONStorage(() => localStorage),
      // Persist:
      //   - the toast-muting flags
      //   - a narrow slice of mesh settings (autoJoin, deviceName, custom
      //     control URL, trustedPeers). Everything else is ephemeral and
      //     reconstructed from `mesh.status()` + live events on launch.
      partialize: (state) => ({
        toasts: state.toasts,
        mesh: {
          autoJoinOnStart: state.mesh.autoJoinOnStart,
          deviceName: state.mesh.deviceName,
          customControlURL: state.mesh.customControlURL,
          trustedPeers: state.mesh.trustedPeers,
        },
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<RemoteState> & {
          mesh?: Partial<MeshState>
        }
        return {
          ...current,
          toasts: { ...current.toasts, ...(p.toasts ?? {}) },
          mesh: { ...current.mesh, ...(p.mesh ?? {}) },
        }
      },
    }
  )
)

// Subscribe to backend events once (at module load). The renderer runs in a
// single process so this lives for the lifetime of the app.
let unsubscribeRemoteEvents: (() => void) | undefined
let unsubscribeMeshEvents: (() => void) | undefined
if (typeof window !== 'undefined' && window.electronAPI?.remote?.onEvent) {
  unsubscribeRemoteEvents = window.electronAPI.remote.onEvent((event: RemoteEvent) => {
    const set = (updater: (s: RemoteState) => Partial<RemoteState>) => {
      useRemoteStore.setState((s) => updater(s))
    }
    switch (event.type) {
      case 'share:created': {
        // If we already have it (from createShare), ignore. Otherwise fetch
        // the full list to populate — we won't have a url/token here.
        const has = useRemoteStore
          .getState()
          .tunnel.shares.some((s) => s.shareId === event.shareId)
        if (!has) {
          useRemoteStore.getState().refreshStatus()
        }
        break
      }
      case 'share:stopped': {
        set((s) => ({
          tunnel: {
            ...s.tunnel,
            shares: s.tunnel.shares.filter((sh) => sh.shareId !== event.shareId),
          },
        }))
        break
      }
      case 'share:client-joined':
      case 'share:client-left': {
        set((s) => ({
          tunnel: {
            ...s.tunnel,
            shares: s.tunnel.shares.map((sh) =>
              sh.shareId === event.shareId
                ? { ...sh, connectedClients: event.connectedClients }
                : sh
            ),
          },
        }))
        break
      }
      case 'tunnel:started': {
        set((s) => ({
          tunnel: {
            ...s.tunnel,
            tunnelUrl: event.tunnelUrl,
            cloudflaredRunning: true,
          },
        }))
        break
      }
      case 'tunnel:stopped':
      case 'tunnel:crashed': {
        set((s) => ({
          tunnel: {
            ...s.tunnel,
            tunnelUrl: null,
            cloudflaredRunning: false,
          },
        }))
        break
      }
    }
  })
}

if (
  typeof window !== 'undefined' &&
  window.electronAPI?.remote?.mesh?.onEvent
) {
  unsubscribeMeshEvents = window.electronAPI.remote.mesh.onEvent((event: MeshEvent) => {
    const set = (updater: (s: RemoteState) => Partial<RemoteState>) => {
      useRemoteStore.setState((s) => updater(s))
    }
    switch (event.type) {
      case 'state': {
        set((s) => ({
          mesh: {
            ...s.mesh,
            status: event.state,
            tailnetIp: event.tailnetIp ?? s.mesh.tailnetIp,
            // Once we reach 'running' we know auth completed.
            authUrl: event.state === 'running' ? null : s.mesh.authUrl,
            enabled:
              event.state === 'running' ||
              event.state === 'starting' ||
              event.state === 'needs_login'
                ? true
                : s.mesh.enabled,
          },
        }))
        break
      }
      case 'auth_url': {
        set((s) => ({ mesh: { ...s.mesh, authUrl: event.url } }))
        break
      }
      case 'peers': {
        // Drop persistent peer sessions for hosts that are no longer
        // visible or have gone offline. Important: also call disconnectPeer
        // on the main side — otherwise the underlying MeshClientSession
        // keeps its reconnect timer and event subscriptions alive
        // (mesh-client.ts only self-destructs on 'gave-up' or explicit
        // close, not on a peers-list removal).
        const onlineNames = new Set(
          event.peers.filter((p) => p.online).map((p) => p.name),
        )
        const beforeSessions = useRemoteStore.getState().mesh.peerSessions
        const toDisconnect: string[] = []
        for (const [name, ps] of Object.entries(beforeSessions)) {
          if (!onlineNames.has(name) && ps.sessionId) {
            toDisconnect.push(ps.sessionId)
          }
        }
        set((s) => {
          const nextSessions = { ...s.mesh.peerSessions }
          let changed = false
          for (const name of Object.keys(nextSessions)) {
            if (!onlineNames.has(name)) {
              delete nextSessions[name]
              changed = true
            }
          }
          return {
            mesh: {
              ...s.mesh,
              peers: event.peers,
              peerSessions: changed ? nextSessions : s.mesh.peerSessions,
            },
          }
        })
        for (const sid of toDisconnect) {
          // Fire-and-forget; the IPC handler is idempotent and the
          // peer_disconnect event it triggers is harmless (entry already
          // removed above, sessionId mismatch).
          void window.electronAPI.remote.mesh.disconnectPeer(sid)
        }
        break
      }
      case 'host_mode': {
        set((s) => ({ mesh: { ...s.mesh, hostMode: event.enabled } }))
        break
      }
      case 'peer_first_connect': {
        const state = useRemoteStore.getState()
        if (state.mesh.trustedPeers.includes(event.peerName)) break
        state.pushToast({
          kind: 'peer-first-connect',
          title: `${event.peerName} connected`,
          body: 'They can now view your tabs and type commands.',
          peerName: event.peerName,
        })
        break
      }
      case 'peer_disconnect': {
        const terminal = event.terminal === true
        set((s) => {
          const nextActive = { ...s.mesh.activeSessions }
          delete nextActive[event.sessionId]
          // Persistent sidebar entries: drop ONLY on a terminal disconnect
          // (gave-up). A transient close means mesh-client is already
          // reconnecting; dropping would orphan the underlying session and
          // cause a duplicate connection on the next user re-expand.
          // Match by sessionId rather than peerHostname so a fresh retry
          // for the same host isn't clobbered.
          if (!terminal) {
            return { mesh: { ...s.mesh, activeSessions: nextActive } }
          }
          const nextPeer = { ...s.mesh.peerSessions }
          let peerChanged = false
          for (const [hostname, ps] of Object.entries(nextPeer)) {
            if (ps.sessionId === event.sessionId) {
              delete nextPeer[hostname]
              peerChanged = true
            }
          }
          return {
            mesh: {
              ...s.mesh,
              activeSessions: nextActive,
              peerSessions: peerChanged ? nextPeer : s.mesh.peerSessions,
            },
          }
        })
        break
      }
      case 'peer_tab_created': {
        set((s) => {
          const cur = s.mesh.peerSessions[event.peerHostname]
          if (!cur || cur.sessionId !== event.sessionId) return s
          if (cur.tabs.some((t) => t.id === event.tab.id)) return s
          return {
            mesh: {
              ...s.mesh,
              peerSessions: {
                ...s.mesh.peerSessions,
                [event.peerHostname]: {
                  ...cur,
                  tabs: [...cur.tabs, event.tab],
                },
              },
            },
          }
        })
        break
      }
      case 'peer_tab_closed': {
        set((s) => {
          const cur = s.mesh.peerSessions[event.peerHostname]
          if (!cur || cur.sessionId !== event.sessionId) return s
          const filtered = cur.tabs.filter((t) => t.id !== event.tabId)
          if (filtered.length === cur.tabs.length) return s
          return {
            mesh: {
              ...s.mesh,
              peerSessions: {
                ...s.mesh.peerSessions,
                [event.peerHostname]: { ...cur, tabs: filtered },
              },
            },
          }
        })
        break
      }
      case 'remote_tab_exit': {
        // RemoteTerminal also subscribes to its per-tab data channel and
        // will show an overlay. Nothing store-wide to do for now.
        break
      }
      case 'connect_retry': {
        // Surface a single info toast on the first retry so the Connect
        // button doesn't appear frozen during the (up to ~7s of backoff +
        // ~20s per handshake) retry sequence. Skip later attempts — they'd
        // just stack identical toasts.
        if (event.attempt === 1) {
          useRemoteStore.getState().pushToast({
            kind: 'info',
            title: `Connecting to ${event.peerHostname}…`,
            body: `Slow link — retrying (up to ${event.maxAttempts} attempts).`,
            ttlMs: 8000,
          })
        }
        break
      }
      case 'crashed': {
        useRemoteStore.getState().pushToast({
          kind: 'reconnecting',
          title: 'Mesh reconnecting…',
          body: 'Sidecar exited; restarting automatically.',
          ttlMs: 6000,
        })
        break
      }
      case 'error': {
        // The backend prefixes MeshServer errors with their code, e.g.
        // "version_mismatch: remote claude-code-pro too old". Surface the
        // two we care about specially.
        const msg = event.message || ''
        if (/version_mismatch/i.test(msg) || event.code === 'version_mismatch') {
          useRemoteStore.getState().pushToast({
            kind: 'version-mismatch',
            title: 'Peer version incompatible',
            body: "The peer's claude-code-pro is too old. Upgrade both ends to the latest.",
          })
        } else {
          useRemoteStore.getState().pushToast({
            kind: 'error',
            title: 'Mesh error',
            body: msg,
            ttlMs: 8000,
          })
        }
        break
      }
    }
  })
}

// In dev with Vite HMR, this module is re-evaluated on edit. Without cleanup,
// every reload would stack another listener on the preload bridge, producing
// duplicate event handling. Dispose the old subscription before the new module
// takes over.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeRemoteEvents?.()
    unsubscribeMeshEvents?.()
  })
}
