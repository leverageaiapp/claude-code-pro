// ToastStack — stacked non-blocking notifications driven by
// `remoteStore.toastQueue`. Renders in a fixed top-right container and
// handles the interactive patterns from REMOTE_NETWORKING.md §8.6:
//
//   ① peer-first-connect: [知道了] [断开此设备 (v2 TODO)] □ 此设备不再提示
//   ② remote-tab-closed:  [知道了] □ 不再提示
//   ③ version-mismatch:    [知道了] [查看文档]
//   ④ reconnecting:        auto-dismiss
//
// Toasts themselves live in the store as `ToastMessage` records, pushed
// by the mesh event subscription or call-sites like destroyRemoteTerminal.

import { useState } from 'react'
import { Globe, AlertTriangle, X, ExternalLink } from 'lucide-react'
import { useRemoteStore, type ToastMessage } from '../stores/remoteStore'

const DOCS_URL = 'https://github.com/leverageaiapp/claude-code-pro#remote-networking'

export function ToastStack() {
  const toasts = useRemoteStore((s) => s.toastQueue)
  const dismiss = useRemoteStore((s) => s.dismissToast)
  const markPeerTrusted = useRemoteStore((s) => s.markPeerTrusted)
  const setRemoteTabCloseMuted = useRemoteStore((s) => s.setRemoteTabCloseMuted)

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-12 right-3 z-[300] flex flex-col gap-2 items-end pointer-events-none">
      {toasts.map((t) => (
        <ToastCard
          key={t.id}
          toast={t}
          onDismiss={() => dismiss(t.id)}
          onTrustPeer={(name) => markPeerTrusted(name)}
          onMuteRemoteClose={() => setRemoteTabCloseMuted(true)}
        />
      ))}
    </div>
  )
}

function ToastCard({
  toast,
  onDismiss,
  onTrustPeer,
  onMuteRemoteClose,
}: {
  toast: ToastMessage
  onDismiss: () => void
  onTrustPeer: (peerName: string) => void
  onMuteRemoteClose: () => void
}) {
  const [dontShow, setDontShow] = useState(false)

  const isError =
    toast.kind === 'error' || toast.kind === 'version-mismatch'
  const icon =
    toast.kind === 'version-mismatch' || toast.kind === 'error' ? (
      <AlertTriangle size={14} className="text-amber-400 shrink-0" />
    ) : (
      <Globe size={14} className="text-green-400 shrink-0" />
    )

  const handleDismiss = () => {
    if (dontShow) {
      if (toast.kind === 'peer-first-connect' && toast.peerName) {
        onTrustPeer(toast.peerName)
      } else if (toast.kind === 'remote-tab-closed') {
        onMuteRemoteClose()
      }
    }
    onDismiss()
  }

  return (
    <div
      className={`pointer-events-auto w-[360px] max-w-[92vw] bg-[#1e1e1e] border rounded-md shadow-2xl px-3 py-2.5 text-[12.5px] text-gray-200 ${
        isError ? 'border-amber-500/40' : 'border-[#3c3c3c]'
      }`}
    >
      <div className="flex items-start gap-2">
        {icon}
        <div className="flex-1 min-w-0">
          <div className="font-medium text-white truncate">{toast.title}</div>
          {toast.body && (
            <div className="text-[12px] text-gray-400 mt-0.5 break-words">{toast.body}</div>
          )}
        </div>
        <button
          onClick={onDismiss}
          className="shrink-0 p-0.5 text-gray-500 hover:text-gray-300 hover:bg-panel-hover rounded"
          title="Dismiss"
        >
          <X size={12} />
        </button>
      </div>

      {/* Per-kind actions */}
      {toast.kind === 'peer-first-connect' && (
        <div className="flex items-center gap-2 pt-2 flex-wrap">
          <button
            onClick={handleDismiss}
            className="px-2 py-0.5 text-[11.5px] text-white bg-blue-600 hover:bg-blue-700 rounded"
          >
            知道了
          </button>
          {/* 断开此设备: v2 — backend has no kickPeer yet. Shown disabled
              with a tooltip so users know it's coming. */}
          <button
            disabled
            title="v2: backend kickPeer not implemented"
            className="px-2 py-0.5 text-[11.5px] text-gray-500 bg-[#2a2a2a] rounded cursor-not-allowed"
          >
            断开此设备
          </button>
          <label className="ml-auto flex items-center gap-1 text-[11px] text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
              className="accent-blue-500"
            />
            此设备不再提示
          </label>
          {toast.peerName && (
            <div className="w-full text-[10.5px] text-gray-600 pt-1">
              {/* The peer id here is the synthetic `peer-<rand>` from the backend
                  (it lacks WhoIs data). v2 will resolve to Tailscale hostname. */}
              peer id: <span className="font-mono">{toast.peerName}</span>
            </div>
          )}
        </div>
      )}

      {toast.kind === 'remote-tab-closed' && (
        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={handleDismiss}
            className="px-2 py-0.5 text-[11.5px] text-white bg-blue-600 hover:bg-blue-700 rounded"
          >
            知道了
          </button>
          <label className="ml-auto flex items-center gap-1 text-[11px] text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
              className="accent-blue-500"
            />
            不再提示
          </label>
        </div>
      )}

      {toast.kind === 'version-mismatch' && (
        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={handleDismiss}
            className="px-2 py-0.5 text-[11.5px] text-white bg-blue-600 hover:bg-blue-700 rounded"
          >
            知道了
          </button>
          <button
            onClick={() => {
              window.electronAPI.shell.openExternal(DOCS_URL).catch(() => {})
            }}
            className="px-2 py-0.5 text-[11.5px] text-gray-200 bg-[#2a2a2a] hover:bg-[#333] rounded flex items-center gap-1"
          >
            查看文档 <ExternalLink size={10} />
          </button>
        </div>
      )}
    </div>
  )
}
