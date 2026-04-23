import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { RemoteEvent, RemoteShareInfo } from '../types'

// v0 scope: tunnel share only. Mesh fields intentionally omitted — coming in v1.
// See REMOTE_NETWORKING.md §8.7 for the full eventual schema.

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

interface ToastState {
  // Persisted — once the user dismisses this toast with "don't show again" it
  // stays dismissed. No UI surfaces it in v0 but the flag is reserved.
  remoteTabCloseMuted: boolean
}

interface RemoteState {
  tunnel: TunnelState
  toasts: ToastState
  // actions
  refreshStatus: () => Promise<void>
  createShare: (tabId: string) => Promise<{ ok: boolean; url?: string; error?: string }>
  stopShare: (shareId: string) => Promise<void>
  setRemoteTabCloseMuted: (v: boolean) => void
}

const initialTunnel: TunnelState = {
  cloudflaredRunning: false,
  tunnelUrl: null,
  shares: [],
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
      toasts: { remoteTabCloseMuted: false },

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
    }),
    {
      name: 'claude-code-pro:remote',
      storage: createJSONStorage(() => localStorage),
      // Only persist the toast-muting flags. Tunnel state is ephemeral —
      // shares don't survive an app restart (the backend PTY attachment and
      // cloudflared URL both restart fresh), so we reconstruct it from the
      // backend on startup via refreshStatus().
      partialize: (state) => ({ toasts: state.toasts }),
    }
  )
)

// Subscribe to backend events once (at module load). The renderer runs in a
// single process so this lives for the lifetime of the app.
if (typeof window !== 'undefined' && window.electronAPI?.remote?.onEvent) {
  window.electronAPI.remote.onEvent((event: RemoteEvent) => {
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
