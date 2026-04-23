import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Copy, Check, Link2, AlertTriangle } from 'lucide-react'
import { useRemoteStore, type Share } from '../stores/remoteStore'
import { useTabStore, type Tab } from '../stores/tabStore'

interface Props {
  open: boolean
  onClose: () => void
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

export function RemoteModal({ open, onClose }: Props) {
  const tunnel = useRemoteStore((s) => s.tunnel)
  const createShare = useRemoteStore((s) => s.createShare)
  const stopShare = useRemoteStore((s) => s.stopShare)

  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)

  const terminalTabs = useMemo(() => tabs.filter((t) => t.type === 'terminal'), [tabs])

  const [selectedTabId, setSelectedTabId] = useState<string>('')
  const [shareError, setShareError] = useState<string | null>(null)
  const [isSharing, setIsSharing] = useState(false)
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null)
  const copiedTimerRef = useRef<number | null>(null)

  // Default dropdown to the active tab when opened (if it's a terminal),
  // else the first terminal tab.
  useEffect(() => {
    if (!open) return
    const activeIsTerminal = terminalTabs.find((t) => t.id === activeTabId)
    const next = activeIsTerminal?.id ?? terminalTabs[0]?.id ?? ''
    setSelectedTabId(next)
    setShareError(null)
  }, [open, activeTabId, terminalTabs])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Clear any pending "Copied!" reset timer on unmount so it doesn't fire
  // and call setCopiedShareId on an unmounted component.
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = null
      }
    }
  }, [])

  if (!open) return null

  const handleShare = async () => {
    if (!selectedTabId) return
    setShareError(null)
    setIsSharing(true)
    const res = await createShare(selectedTabId)
    setIsSharing(false)
    if (!res.ok) {
      setShareError(res.error || 'Failed to start share')
    }
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
            <Link2 size={15} className="text-blue-400" />
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Mesh placeholder */}
          <section>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[13px] text-gray-400">
                <span>🌐</span>
                <span className="font-medium">Mesh Network · Tailscale</span>
              </div>
              <span className="text-[11px] text-gray-500 italic">Coming in v1</span>
            </div>
          </section>

          <div className="border-t border-[#3c3c3c]" />

          {/* Tunnel Share */}
          <section className="space-y-3">
            <div className="flex items-center gap-2 text-[13px] text-white">
              <span>🔗</span>
              <span className="font-medium">Tunnel Share · Cloudflare</span>
            </div>

            {/* Warning */}
            <div className="flex gap-2 items-start bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[12px] rounded px-3 py-2">
              <AlertTriangle size={14} className="shrink-0 mt-[2px]" />
              <span>
                Data passes through Cloudflare (not end-to-end encrypted). Sensitive sessions
                should wait for Mesh.
              </span>
            </div>

            {/* Tunnel URL */}
            {tunnel.cloudflaredRunning && tunnel.tunnelUrl && (
              <div className="text-[11px] text-gray-500 font-mono truncate">
                Public tunnel: {tunnel.tunnelUrl}
              </div>
            )}

            {/* Share a tab */}
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

            {/* Active shares */}
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
                            <span>🔗</span>
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
                              URL not available after restart — stop and reshare to get a new
                              link
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
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-[#3c3c3c] text-[10px] text-gray-600 text-center shrink-0">
          claude-code-pro · v0 Tunnel Share
        </div>
      </div>
    </div>
  )
}
