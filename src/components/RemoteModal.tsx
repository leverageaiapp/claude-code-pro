import { useEffect, useMemo, useRef, useState } from 'react'
import {
  X,
  Copy,
  Check,
  Link2,
  AlertTriangle,
  Globe,
  Pencil,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  LogOut,
  ShieldAlert,
} from 'lucide-react'
import { useRemoteStore, type Share } from '../stores/remoteStore'
import { useTabStore, type Tab } from '../stores/tabStore'
import type { MeshPeer, RemoteTabInfo } from '../types'

export type RemoteModalTab = 'mesh' | 'tunnel'

interface Props {
  open: boolean
  onClose: () => void
  /** Which tab to show when the modal is (re-)opened. */
  initialTab?: RemoteModalTab
  /**
   * Called when the user picks a remote peer-tab to open. The parent
   * (App.tsx) is responsible for calling `openRemoteTab` and spawning a
   * new RemoteTerminal tab in the tab store. Keeps this modal pure-ish.
   */
  onOpenRemoteTab?: (args: {
    sessionId: string
    peerHostname: string
    peerTab: RemoteTabInfo
  }) => Promise<void> | void
}

function formatRelativeTime(ts: number): string {
  const delta = Date.now() - ts
  const sec = Math.floor(delta / 1000)
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

// ---------- Mesh Tab ----------

interface HostConfirmProps {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}

function HostConfirmDialog({ open, onCancel, onConfirm }: HostConfirmProps) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-md shadow-2xl w-[480px] max-w-[92vw] p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <ShieldAlert size={18} className="text-amber-400" />
          <span className="text-sm font-semibold text-white">Enable Host mode?</span>
        </div>
        <div className="text-[12.5px] text-gray-300 space-y-2">
          <p>Once enabled, every device on your Tailscale account will be able to:</p>
          <ul className="list-disc pl-5 space-y-0.5 text-gray-400">
            <li>See every tab open on this machine</li>
            <li>Type commands (same effect as typing on this machine's keyboard)</li>
            <li>Open new terminals and run arbitrary commands</li>
          </ul>
          <p className="text-amber-300/90">
            This grants shell access on this machine to all devices in your tailnet. Only enable this if you trust all your own devices.
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-[12px] text-gray-300 hover:bg-panel-hover rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-[12px] text-white bg-amber-600 hover:bg-amber-700 rounded transition-colors"
          >
            I understand, enable
          </button>
        </div>
      </div>
    </div>
  )
}

interface PickPeerTabProps {
  open: boolean
  peerHostname: string
  tabs: RemoteTabInfo[] | null
  error?: string | null
  onCancel: () => void
  onPick: (peerTab: RemoteTabInfo) => void
}

function PickPeerTabDialog({ open, peerHostname, tabs, error, onCancel, onPick }: PickPeerTabProps) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-md shadow-2xl w-[480px] max-w-[92vw] flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#252526] border-b border-[#3c3c3c] rounded-t-md">
          <div className="flex items-center gap-2">
            <Globe size={14} className="text-green-400" />
            <span className="text-sm font-semibold text-white">
              {peerHostname} · pick a tab to open
            </span>
          </div>
          <button
            onClick={onCancel}
            className="p-1 hover:bg-panel-hover rounded"
            title="Close"
          >
            <X size={14} className="text-gray-400" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {error ? (
            <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
              {error}
            </div>
          ) : tabs === null ? (
            <div className="text-[12px] text-gray-500 italic py-3 text-center">
              Loading…
            </div>
          ) : tabs.length === 0 ? (
            <div className="text-[12px] text-gray-500 italic py-3 text-center">
              No tabs currently open on this device
            </div>
          ) : (
            tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => onPick(t)}
                className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-gray-200 hover:bg-panel-hover rounded transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Globe size={12} className="text-green-400 shrink-0" />
                  <span className="truncate">{t.title || t.id}</span>
                </div>
                {t.cwd && (
                  <span className="text-[11px] text-gray-500 truncate max-w-[180px]">
                    {t.cwd}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function MeshTab({
  onOpenRemoteTab,
  onClose,
}: {
  onOpenRemoteTab?: Props['onOpenRemoteTab']
  onClose: () => void
}) {
  const mesh = useRemoteStore((s) => s.mesh)
  const joinMesh = useRemoteStore((s) => s.joinMesh)
  const leaveMesh = useRemoteStore((s) => s.leaveMesh)
  const enableHost = useRemoteStore((s) => s.enableHost)
  const disableHost = useRemoteStore((s) => s.disableHost)
  const setDeviceName = useRemoteStore((s) => s.setDeviceName)
  const setCustomControlURL = useRemoteStore((s) => s.setCustomControlURL)
  const setAutoJoinOnStart = useRemoteStore((s) => s.setAutoJoinOnStart)
  const refreshMeshStatus = useRemoteStore((s) => s.refreshMeshStatus)
  const revokeAllRemoteAccess = useRemoteStore((s) => s.revokeAllRemoteAccess)
  const connectToPeer = useRemoteStore((s) => s.connectToPeer)
  const disconnectFromPeer = useRemoteStore((s) => s.disconnectFromPeer)
  const listPeerTabs = useRemoteStore((s) => s.listPeerTabs)

  const [joinPending, setJoinPending] = useState(false)
  const [hostConfirmOpen, setHostConfirmOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [editingDeviceName, setEditingDeviceName] = useState(false)
  const [draftDeviceName, setDraftDeviceName] = useState(mesh.deviceName)
  const [draftControlURL, setDraftControlURL] = useState(mesh.customControlURL)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false)

  // Peer-tab picker state (for connecting to a peer from the My Devices list).
  const [pickerPeer, setPickerPeer] = useState<MeshPeer | null>(null)
  const [pickerSessionId, setPickerSessionId] = useState<string | null>(null)
  const [pickerTabs, setPickerTabs] = useState<RemoteTabInfo[] | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)

  // Keep drafts in sync when the store updates.
  useEffect(() => setDraftDeviceName(mesh.deviceName), [mesh.deviceName])
  useEffect(() => setDraftControlURL(mesh.customControlURL), [mesh.customControlURL])

  const isRunning = mesh.status === 'running'
  const isStarting = mesh.status === 'starting'
  const needsLogin = mesh.status === 'needs_login' || !!mesh.authUrl

  const handleJoin = async () => {
    setJoinError(null)
    setJoinPending(true)
    const res = await joinMesh()
    setJoinPending(false)
    if (!res.ok) setJoinError(res.error ?? 'Failed to join tailnet')
  }

  const handleSaveDeviceName = async () => {
    const trimmed = draftDeviceName.trim()
    if (!trimmed || trimmed === mesh.deviceName) {
      setEditingDeviceName(false)
      return
    }
    await setDeviceName(trimmed)
    setEditingDeviceName(false)
  }

  const handleHostToggle = async () => {
    if (mesh.hostMode) {
      // OFF is immediate, no confirm.
      await disableHost()
    } else {
      setHostConfirmOpen(true)
    }
  }

  const handleConfirmEnableHost = async () => {
    setHostConfirmOpen(false)
    await enableHost()
  }

  const handleSaveControlURL = async () => {
    await setCustomControlURL(draftControlURL.trim())
  }

  const handleConnectPeer = async (peer: MeshPeer) => {
    setPickerPeer(peer)
    setPickerTabs(null)
    setPickerError(null)
    const res = await connectToPeer(peer.name)
    if (!res.ok || !res.sessionId) {
      setPickerError(res.error ?? 'Failed to connect to peer')
      return
    }
    setPickerSessionId(res.sessionId)
    const tabsRes = await listPeerTabs(res.sessionId)
    if (!tabsRes.ok) {
      setPickerError(tabsRes.error ?? 'Failed to list peer tabs')
      return
    }
    setPickerTabs(tabsRes.tabs ?? [])
  }

  const handlePickPeerTab = async (peerTab: RemoteTabInfo) => {
    if (!pickerSessionId || !pickerPeer) return
    try {
      await onOpenRemoteTab?.({
        sessionId: pickerSessionId,
        peerHostname: pickerPeer.name,
        peerTab,
      })
    } finally {
      setPickerPeer(null)
      setPickerSessionId(null)
      setPickerTabs(null)
      onClose()
    }
  }

  const handleCancelPicker = async () => {
    if (pickerSessionId) {
      // Session was created but user bailed — tear it down so we don't
      // leak a WS. If they connect again we'll mint a fresh sessionId.
      await disconnectFromPeer(pickerSessionId)
    }
    setPickerPeer(null)
    setPickerSessionId(null)
    setPickerTabs(null)
    setPickerError(null)
  }

  const handleRevokeAll = async () => {
    setRevokeConfirmOpen(false)
    await revokeAllRemoteAccess()
    // Nudge the user to clean up the tailnet admin UI.
    try {
      await window.electronAPI.shell.openExternal(
        'https://login.tailscale.com/admin/machines'
      )
    } catch {
      // ignore
    }
  }

  // Not joined yet — show the big onboarding CTA.
  if (!mesh.enabled) {
    return (
      <section className="space-y-4">
        <div className="flex items-center gap-2 text-[13px] text-white">
          <Globe size={14} className="text-green-400" />
          <span className="font-medium">Mesh Network · Tailscale</span>
        </div>
        <div className="text-[12.5px] text-gray-400 space-y-2">
          <p>
            Join this machine to your Tailscale tailnet to mesh with the other devices on your
            account. Traffic is end-to-end encrypted (WireGuard) and peer-to-peer — it does
            not pass through a third-party relay.
          </p>
          <p>
            The first time you join, a browser tab opens for Tailscale login. Afterwards the
            app rejoins automatically on startup unless you click Leave.
          </p>
        </div>

        {/* Advanced: device name + custom control URL even before first join. */}
        <div className="space-y-2">
          <div className="text-[11px] uppercase text-gray-500">Device name</div>
          <input
            type="text"
            value={draftDeviceName}
            onChange={(e) => setDraftDeviceName(e.target.value)}
            onBlur={() => setDeviceName(draftDeviceName.trim())}
            placeholder="Auto (hostname)"
            className="w-full bg-[#2a2a2a] border border-[#3c3c3c] text-white text-[12px] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          />
        </div>

        <button
          onClick={handleJoin}
          disabled={joinPending}
          className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-900 disabled:text-gray-400 text-white text-[13px] rounded-md transition-colors"
        >
          {joinPending ? 'Connecting…' : 'Join tailnet'}
        </button>

        {joinError && (
          <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
            {joinError}
          </div>
        )}

        <div className="text-[11px] text-gray-500 text-center pt-1">
          Powered by Tailscale · end-to-end encrypted · no Cloudflare in the path
        </div>
      </section>
    )
  }

  // Joined — full mesh UI.
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] text-white">
          <Globe size={14} className="text-green-400" />
          <span className="font-medium">Mesh Network · Tailscale</span>
        </div>
        <button
          onClick={() => void refreshMeshStatus()}
          className="p-1 hover:bg-panel-hover rounded text-gray-400"
          title="Refresh status"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* Auth URL, if pending */}
      {needsLogin && mesh.authUrl && (
        <div className="text-[12px] text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2 space-y-2">
          <div>Finish Tailscale login in your browser to activate this device:</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (mesh.authUrl) {
                  window.electronAPI.shell.openExternal(mesh.authUrl).catch(() => {
                    window.open(mesh.authUrl!, '_blank')
                  })
                }
              }}
              className="px-3 py-1 text-[11.5px] bg-amber-600 hover:bg-amber-700 text-white rounded"
            >
              Open login link
            </button>
            <button
              onClick={() => {
                if (mesh.authUrl) navigator.clipboard.writeText(mesh.authUrl)
              }}
              className="px-2 py-1 text-[11.5px] text-gray-300 hover:bg-panel-hover rounded"
            >
              Copy URL
            </button>
          </div>
          <div className="font-mono text-[10.5px] text-gray-400 break-all">{mesh.authUrl}</div>
        </div>
      )}

      {/* Status block */}
      <div className="bg-[#252526] border border-[#3c3c3c] rounded p-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              isRunning
                ? 'bg-green-500'
                : isStarting || needsLogin
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-gray-500'
            }`}
          />
          <span className="text-[12.5px] text-gray-200 font-medium">
            {isRunning
              ? 'Joined tailnet'
              : isStarting
                ? 'Connecting…'
                : needsLogin
                  ? 'Waiting for login'
                  : 'Not joined'}
          </span>
        </div>
        {/* Device name (inline editor) */}
        <div className="flex items-center gap-2 text-[12px] text-gray-400">
          <span className="text-gray-500">Device name:</span>
          {editingDeviceName ? (
            <>
              <input
                type="text"
                value={draftDeviceName}
                onChange={(e) => setDraftDeviceName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveDeviceName()
                  if (e.key === 'Escape') {
                    setDraftDeviceName(mesh.deviceName)
                    setEditingDeviceName(false)
                  }
                }}
                autoFocus
                className="bg-[#2a2a2a] border border-[#3c3c3c] text-white text-[12px] rounded px-1.5 py-0.5 min-w-[120px] focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleSaveDeviceName}
                className="text-[11px] text-blue-400 hover:text-blue-300"
              >
                Save
              </button>
            </>
          ) : (
            <>
              <span className="text-gray-200 font-mono">{mesh.deviceName || '(auto)'}</span>
              <button
                onClick={() => setEditingDeviceName(true)}
                className="p-0.5 hover:bg-panel-hover rounded text-gray-500"
                title="Rename (requires sidecar restart)"
              >
                <Pencil size={10} />
              </button>
            </>
          )}
        </div>
        <div className="text-[12px] text-gray-400">
          <span className="text-gray-500">IP:</span>{' '}
          <span className="text-gray-200 font-mono">
            {mesh.tailnetIp ?? '—'}
          </span>
        </div>
      </div>

      <div className="border-t border-[#3c3c3c]" />

      {/* Host mode */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] text-white font-medium">Host mode</div>
          <div className="text-[11.5px] text-gray-500 mt-0.5">
            Allow other devices to connect and operate tabs on this machine
          </div>
        </div>
        <button
          onClick={handleHostToggle}
          className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            mesh.hostMode ? 'bg-amber-500' : 'bg-[#3c3c3c]'
          }`}
          role="switch"
          aria-checked={mesh.hostMode}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
              mesh.hostMode ? 'translate-x-[18px]' : 'translate-x-[3px]'
            }`}
          />
        </button>
      </div>

      <div className="border-t border-[#3c3c3c]" />

      {/* My Devices */}
      <div className="space-y-2">
        <div className="text-[12.5px] text-white font-medium">
          My Devices{' '}
          <span className="text-gray-500 font-normal">({mesh.peers.length})</span>
        </div>
        {mesh.peers.length === 0 ? (
          <div className="text-[12px] text-gray-500 italic">
            No other devices yet. Sign in to the same Tailscale account on another device to link them.
          </div>
        ) : (
          <div className="space-y-1">
            {mesh.peers.map((peer) => (
              <div
                key={peer.name}
                className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-panel-hover"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                      peer.online ? 'bg-green-500' : 'bg-gray-500'
                    }`}
                  />
                  <span className="text-[12.5px] text-gray-200 truncate">{peer.name}</span>
                  {!peer.online && (
                    <span className="text-[10.5px] text-gray-500">offline</span>
                  )}
                </div>
                {peer.online && (
                  <button
                    onClick={() => handleConnectPeer(peer)}
                    className="shrink-0 text-[11.5px] text-blue-400 hover:text-blue-300 px-2 py-0.5 rounded hover:bg-blue-500/10"
                    title="Connect to peer"
                  >
                    → Connect
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-[#3c3c3c]" />

      {/* Settings */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-[12px] text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={mesh.autoJoinOnStart}
            onChange={(e) => setAutoJoinOnStart(e.target.checked)}
            className="accent-blue-500"
          />
          Auto-join tailnet on app start
        </label>

        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1 text-[11.5px] text-gray-400 hover:text-gray-200"
        >
          {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Advanced: custom Coordination Server
        </button>

        {advancedOpen && (
          <div className="space-y-2 pl-4">
            <div className="text-[11px] text-gray-500">
              Defaults to Tailscale's official control plane. Only fill this in if you run your own headscale; leave empty for the default.
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={draftControlURL}
                onChange={(e) => setDraftControlURL(e.target.value)}
                placeholder="https://headscale.example.com"
                className="flex-1 bg-[#2a2a2a] border border-[#3c3c3c] text-white text-[12px] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleSaveControlURL}
                className="shrink-0 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-[12px] rounded"
              >
                Save
              </button>
            </div>
            <div className="text-[10.5px] text-amber-400">
              Changing this restarts the sidecar — it reconnects automatically.
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-[#3c3c3c]" />

      {/* Revoke all */}
      <div className="space-y-2">
        <button
          onClick={() => setRevokeConfirmOpen(true)}
          className="flex items-center gap-1.5 text-[12px] text-red-400 hover:text-red-300"
        >
          <LogOut size={12} />
          Revoke all remote access
        </button>
        <div className="text-[10.5px] text-gray-500 pl-5">
          Disables Host mode, closes all outbound sessions, leaves the tailnet, and opens the Tailscale admin console so you can remove the other devices.
        </div>
      </div>

      <div className="text-[10.5px] text-gray-600 text-center pt-1">
        Powered by Tailscale ·{' '}
        <button
          onClick={() =>
            window.electronAPI.shell.openExternal(
              'https://github.com/leverageaiapp/claude-code-pro#remote-networking'
            )
          }
          className="underline hover:text-gray-400"
        >
          Help
        </button>
      </div>

      <HostConfirmDialog
        open={hostConfirmOpen}
        onCancel={() => setHostConfirmOpen(false)}
        onConfirm={handleConfirmEnableHost}
      />
      <PickPeerTabDialog
        open={pickerPeer !== null}
        peerHostname={pickerPeer?.name ?? ''}
        tabs={pickerTabs}
        error={pickerError}
        onCancel={handleCancelPicker}
        onPick={handlePickPeerTab}
      />
      {revokeConfirmOpen && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
          onClick={() => setRevokeConfirmOpen(false)}
        >
          <div
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-md shadow-2xl w-[440px] max-w-[92vw] p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <ShieldAlert size={18} className="text-red-400" />
              <span className="text-sm font-semibold text-white">
                Revoke all remote access?
              </span>
            </div>
            <div className="text-[12.5px] text-gray-300">
              This disables Host mode, closes all connected peers, leaves the tailnet, and opens the Tailscale admin console so you can remove the remaining devices.
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setRevokeConfirmOpen(false)}
                className="px-3 py-1.5 text-[12px] text-gray-300 hover:bg-panel-hover rounded"
              >
                Cancel
              </button>
              <button
                onClick={handleRevokeAll}
                className="px-3 py-1.5 text-[12px] text-white bg-red-600 hover:bg-red-700 rounded"
              >
                Revoke
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------- Tunnel Tab (unchanged behaviour, pulled into a sub-component) ----------

function TunnelTab() {
  const tunnel = useRemoteStore((s) => s.tunnel)
  const createShare = useRemoteStore((s) => s.createShare)
  const stopShare = useRemoteStore((s) => s.stopShare)

  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)

  const terminalTabs = useMemo(
    () => tabs.filter((t) => t.type === 'terminal'),
    [tabs]
  )

  const [selectedTabId, setSelectedTabId] = useState<string>('')
  const [shareError, setShareError] = useState<string | null>(null)
  const [isSharing, setIsSharing] = useState(false)
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null)
  const copiedTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const activeIsTerminal = terminalTabs.find((t) => t.id === activeTabId)
    const next = activeIsTerminal?.id ?? terminalTabs[0]?.id ?? ''
    setSelectedTabId(next)
    setShareError(null)
  }, [activeTabId, terminalTabs])

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = null
      }
    }
  }, [])

  const handleShare = async () => {
    if (!selectedTabId) return
    setShareError(null)
    setIsSharing(true)
    const res = await createShare(selectedTabId)
    setIsSharing(false)
    if (!res.ok) setShareError(res.error || 'Failed to start share')
  }

  const handleCopy = (share: Share) => {
    if (!share.url) return
    navigator.clipboard.writeText(share.url)
    setCopiedShareId(share.shareId)
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current)
    }
    copiedTimerRef.current = window.setTimeout(() => {
      copiedTimerRef.current = null
      setCopiedShareId((cur) => (cur === share.shareId ? null : cur))
    }, 2000)
  }

  const tabById = (id: string): Tab | undefined => tabs.find((t) => t.id === id)

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-[13px] text-white">
        <Link2 size={14} className="text-blue-400" />
        <span className="font-medium">Tunnel Share · Cloudflare</span>
      </div>

      <div className="flex gap-2 items-start bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[12px] rounded px-3 py-2">
        <AlertTriangle size={14} className="shrink-0 mt-[2px]" />
        <span>
          Data passes through Cloudflare (not end-to-end encrypted). Sensitive sessions should use Mesh.
        </span>
      </div>

      {tunnel.cloudflaredRunning && tunnel.tunnelUrl && (
        <div className="text-[11px] text-gray-500 font-mono truncate">
          Public tunnel: {tunnel.tunnelUrl}
        </div>
      )}

      <div className="space-y-2">
        <div className="text-[12px] text-gray-300 font-medium">Share a Tab</div>
        {terminalTabs.length === 0 ? (
          <div className="text-[12px] text-gray-500 italic">
            No terminal tabs open. Open a terminal to share it.
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <select
              value={selectedTabId}
              onChange={(e) => setSelectedTabId(e.target.value)}
              className="flex-1 bg-[#2a2a2a] border border-[#3c3c3c] text-white text-[12px] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
            >
              {terminalTabs.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <button
              onClick={handleShare}
              disabled={!selectedTabId || isSharing}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-900 disabled:text-gray-400 text-white text-[12px] rounded transition-colors shrink-0"
            >
              {isSharing ? 'Sharing…' : 'Share Selected Tab'}
            </button>
          </div>
        )}
        {shareError && (
          <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
            {shareError}
          </div>
        )}
      </div>

      <div className="space-y-2 pt-2">
        <div className="text-[12px] text-gray-300 font-medium">
          Active Shares{' '}
          {tunnel.shares.length > 0 && (
            <span className="text-gray-500">({tunnel.shares.length})</span>
          )}
        </div>
        {tunnel.shares.length === 0 ? (
          <div className="text-[12px] text-gray-500 italic">No active shares</div>
        ) : (
          <div className="space-y-2">
            {tunnel.shares.map((share) => {
              const tab = tabById(share.tabId)
              const tabTitle = tab?.title ?? '(closed tab)'
              const copied = copiedShareId === share.shareId
              const hasUrl = share.url.length > 0
              return (
                <div
                  key={share.shareId}
                  className="bg-[#252526] border border-[#3c3c3c] rounded px-3 py-2 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Link2 size={12} className="text-blue-400 shrink-0" />
                      <span className="text-[13px] text-white truncate">{tabTitle}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleCopy(share)}
                        disabled={!hasUrl}
                        className="flex items-center gap-1 px-2 py-1 text-[11px] text-gray-300 hover:bg-panel-hover disabled:text-gray-600 disabled:hover:bg-transparent rounded transition-colors"
                        title={hasUrl ? 'Copy link' : 'URL not available'}
                      >
                        {copied ? (
                          <>
                            <Check size={11} className="text-green-400" />
                            <span className="text-green-400">Copied!</span>
                          </>
                        ) : (
                          <>
                            <Copy size={11} />
                            <span>Copy Link</span>
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => stopShare(share.shareId)}
                        className="px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/20 rounded transition-colors"
                        title="Stop sharing"
                      >
                        Stop
                      </button>
                    </div>
                  </div>
                  <div className="font-mono text-[11px] text-gray-400 break-all">
                    {hasUrl ? (
                      share.url
                    ) : (
                      <span className="italic text-gray-500">
                        URL not available after restart — stop and reshare to get a new link
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-gray-500">
                    <span>shared {formatRelativeTime(share.createdAt)}</span>
                    <span>
                      {share.connectedClients}{' '}
                      {share.connectedClients === 1 ? 'client' : 'clients'} connected
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

// ---------- Outer Modal ----------

export function RemoteModal({ open, onClose, initialTab = 'mesh', onOpenRemoteTab }: Props) {
  const [active, setActive] = useState<RemoteModalTab>(initialTab)

  // Reset tab selection each time the modal opens (so a fresh click on
  // the 🌐 icon always lands on Mesh, and 🔗 lands on Tunnel).
  useEffect(() => {
    if (open) setActive(initialTab)
  }, [open, initialTab])

  // Pull in fresh status whenever the modal opens.
  useEffect(() => {
    if (!open) return
    useRemoteStore.getState().refreshMeshStatus()
    useRemoteStore.getState().refreshStatus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-md shadow-2xl w-[640px] max-w-[92vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#252526] border-b border-[#3c3c3c] rounded-t-md shrink-0">
          <div className="flex items-center gap-2">
            <Globe size={15} className="text-green-400" />
            <span className="text-sm font-semibold text-white">Remote Networking</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-panel-hover rounded transition-colors"
            title="Close"
          >
            <X size={15} className="text-gray-400" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-[#3c3c3c] bg-[#252526] shrink-0">
          <button
            onClick={() => setActive('mesh')}
            className={`px-4 py-2 text-[12.5px] transition-colors flex items-center gap-1.5 ${
              active === 'mesh'
                ? 'text-white border-b-2 border-blue-500'
                : 'text-gray-400 hover:text-gray-200 border-b-2 border-transparent'
            }`}
          >
            <Globe size={12} />
            Mesh
          </button>
          <button
            onClick={() => setActive('tunnel')}
            className={`px-4 py-2 text-[12.5px] transition-colors flex items-center gap-1.5 ${
              active === 'tunnel'
                ? 'text-white border-b-2 border-blue-500'
                : 'text-gray-400 hover:text-gray-200 border-b-2 border-transparent'
            }`}
          >
            <Link2 size={12} />
            Tunnel Share
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {active === 'mesh' ? (
            <MeshTab onOpenRemoteTab={onOpenRemoteTab} onClose={onClose} />
          ) : (
            <TunnelTab />
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-[#3c3c3c] text-[10px] text-gray-600 text-center shrink-0">
          claude-code-pro · v1 Mesh + Tunnel Share
        </div>
      </div>
    </div>
  )
}
