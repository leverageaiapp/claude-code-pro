// RemoteTerminal — xterm.js panel wired to a remote-mesh PTY pipe.
//
// Mirrors the shape of Terminal.tsx but replaces the local terminal IPC with
// the `remote.mesh` surface:
//   - No `terminal:create` (the PTY already lives on the host);
//   - subscribe to `remote:mesh:tab:data:<localSessionId>`;
//   - user input goes to `writeRemoteTab(localSessionId, data)`;
//   - unmount calls `closeRemoteTab(localSessionId)` which keeps the remote
//     PTY alive (only `killRemoteTab` / Close-on-Host actually kills it).
//
// History handling: the first message on subscribe is `{type:'history'}`
// containing the last N chunks from the host's ring buffer; write them in
// order to prime the view, then live chunks flow via `{type:'output'}`.

import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal as XTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { AlertTriangle, ShieldAlert } from 'lucide-react'
import { debug } from '../stores/debugStore'
import { useRemoteStore } from '../stores/remoteStore'
import { useTabStore } from '../stores/tabStore'
import type { RemoteTerminalTab } from '../stores/tabStore'
import type { MeshTabDataMsg } from '../types'

interface Props {
  tab: RemoteTerminalTab
  isActive: boolean
}

// Keep xterm instances alive across re-renders so scrollback survives tab
// visibility toggles. Indexed by our local tab id (stable for the lifetime
// of the renderer).
const remoteTerminals = new Map<
  string,
  { term: XTerminal; fit: FitAddon; wired: boolean }
>()

export function RemoteTerminalPanel({ tab, isActive }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [peerExited, setPeerExited] = useState<{ code: number } | null>(null)
  const [killConfirm, setKillConfirm] = useState(false)
  const updateRemoteTabStatus = useTabStore((s) => s.updateRemoteTabStatus)
  const killRemoteTab = useRemoteStore((s) => s.killRemoteTab)
  const pushToast = useRemoteStore((s) => s.pushToast)
  const peers = useRemoteStore((s) => s.mesh.peers)

  // Derive peer IP for the status bar. Purely cosmetic — if we can't find it,
  // show a placeholder.
  const peerIp = peers.find((p) => p.name === tab.peerHostname)?.ip ?? null

  // Close-on-Host confirmation handler (⌘⇧W).
  const handleCloseOnHost = useCallback(async () => {
    const res = await killRemoteTab(tab.localSessionId)
    setKillConfirm(false)
    if (!res.ok) {
      pushToast({
        kind: 'error',
        title: 'Close on Host failed',
        body: res.error ?? 'Unknown error',
        ttlMs: 6000,
      })
    }
    // Backend will emit `remote_tab_exit` and the tab-data channel will
    // deliver `{type:'exit'}`; we leave the Tab visible with the overlay
    // until the user closes it locally.
  }, [killRemoteTab, pushToast, tab.localSessionId])

  // Wire up the xterm instance + data channel once per mount.
  useEffect(() => {
    if (!containerRef.current) return

    let instance = remoteTerminals.get(tab.id)
    if (!instance) {
      const term = new XTerminal({
        theme: {
          background: '#1e1e1e',
          foreground: '#cccccc',
          cursor: '#ffffff',
          selectionBackground: '#264f78',
        },
        fontSize: 13,
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        cursorBlink: true,
        scrollback: 10000,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.loadAddon(
        new WebLinksAddon((_e, uri) => {
          window.electronAPI.shell.openExternal(uri).catch(() => {})
        })
      )
      instance = { term, fit, wired: false }
      remoteTerminals.set(tab.id, instance)
    }

    const { term, fit } = instance

    if (containerRef.current.childElementCount === 0) {
      term.open(containerRef.current)
    }
    fit.fit()

    let unsubData: (() => void) | null = null
    if (!instance.wired) {
      instance.wired = true
      updateRemoteTabStatus(tab.id, 'connecting')

      unsubData = window.electronAPI.remote.mesh.onRemoteTabData(
        tab.localSessionId,
        (msg: MeshTabDataMsg) => {
          switch (msg.type) {
            case 'history': {
              term.clear()
              for (const chunk of msg.data) {
                term.write(chunk)
              }
              if (msg.truncated) {
                term.write(
                  '\r\n\x1b[33m[history truncated — earlier output dropped]\x1b[0m\r\n'
                )
              }
              // After history lands we consider ourselves connected.
              updateRemoteTabStatus(tab.id, 'connected')
              break
            }
            case 'output': {
              term.write(msg.data)
              break
            }
            case 'exit': {
              setPeerExited({ code: msg.code })
              updateRemoteTabStatus(tab.id, 'peer-exited')
              term.write(
                `\r\n\x1b[33m[host tab exited · code ${msg.code}]\x1b[0m\r\n`
              )
              break
            }
            case 'error': {
              debug(
                'RemoteTerminal',
                `error from host: ${msg.code} ${msg.message ?? ''}`,
                'error'
              )
              updateRemoteTabStatus(tab.id, 'disconnected')
              break
            }
          }
        }
      )

      term.onData((data) => {
        void window.electronAPI.remote.mesh.writeRemoteTab(tab.localSessionId, data)
      })

      // xterm copy: clean trailing whitespace just like Terminal.tsx.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && e.key === 'c') {
          const sel = term.getSelection()
          if (sel) {
            const cleaned = sel
              .split('\n')
              .map((line) => line.replace(/\s+$/, ''))
              .join('\n')
              .replace(/\n+$/, '')
            navigator.clipboard.writeText(cleaned).catch(() => {})
            return false
          }
        }
        return true
      })

      // NOTE: we intentionally don't call `resize()` on the mesh bridge — the
      // host's PTY geometry is decided by the host, and each additional
      // viewer negotiating resize would fight last-writer-wins. v2 TODO.
      setTimeout(() => {
        try {
          fit.fit()
        } catch {
          // ignore
        }
      }, 100)
    }

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // ignore
      }
    })
    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      unsubData?.()
    }
    // The effect is keyed by tab.id + localSessionId — neither changes across
    // renders for a given remote tab, but if the backend reconnects and mints
    // a new session id (v2) we'd want to rewire.
  }, [tab.id, tab.localSessionId, updateRemoteTabStatus])

  // Re-fit + focus when this tab becomes active.
  useEffect(() => {
    if (!isActive) return
    const instance = remoteTerminals.get(tab.id)
    if (!instance) return
    const delays = [0, 50, 150]
    const timers = delays.map((ms) =>
      setTimeout(() => {
        try {
          instance.fit.fit()
          instance.term.focus()
        } catch {
          // ignore
        }
      }, ms)
    )
    return () => timers.forEach(clearTimeout)
  }, [isActive, tab.id])

  // Keyboard shortcut: ⌘⇧W / Ctrl+Shift+W → Close on Host (with confirm).
  useEffect(() => {
    if (!isActive) return
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.shiftKey && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault()
        setKillConfirm(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isActive])

  // Right-click context menu for Close on Host.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [ctxMenu])

  return (
    <div
      ref={wrapperRef}
      className="w-full h-full flex flex-col relative"
      onContextMenu={(e) => {
        e.preventDefault()
        setCtxMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <div
        ref={containerRef}
        className="flex-1 min-h-0"
        style={{ padding: '4px', background: '#1e1e1e' }}
      />
      {/* Status bar */}
      <div
        className={`flex items-center justify-between px-3 py-[2px] text-[10.5px] border-t border-[#3c3c3c] shrink-0 ${
          tab.status === 'disconnected'
            ? 'bg-red-900/40 text-red-300'
            : tab.status === 'peer-exited'
              ? 'bg-amber-900/40 text-amber-300'
              : 'bg-[#252526] text-gray-400'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-green-400">🌐</span>
          <span className="font-mono">
            {tab.peerHostname}
            {peerIp ? ` @ ${peerIp}` : ''} · tailnet
          </span>
        </div>
        <div className="font-mono text-[10px]">
          {tab.status === 'connecting' && 'Connecting…'}
          {tab.status === 'connected' && 'Live'}
          {tab.status === 'disconnected' && 'Reconnecting…'}
          {tab.status === 'peer-exited' && 'Host tab exited'}
        </div>
      </div>

      {peerExited && (
        <div className="absolute inset-0 flex items-start justify-center pointer-events-none pt-10">
          <div className="bg-[#252526]/90 border border-amber-500/40 rounded px-3 py-2 flex items-center gap-2 text-[12px] text-amber-200 pointer-events-auto">
            <AlertTriangle size={14} />
            Host tab exited (code {peerExited.code}). Input disabled.
          </div>
        </div>
      )}

      {ctxMenu && (
        <div
          className="fixed z-[150] bg-[#252526] border border-[#3c3c3c] rounded shadow-2xl py-1 min-w-[180px]"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              setCtxMenu(null)
              setKillConfirm(true)
            }}
            className="w-full text-left text-[12px] px-3 py-1.5 text-red-400 hover:bg-red-500/20 flex items-center justify-between"
          >
            <span>Close on Host…</span>
            <span className="text-[10px] text-gray-500">⌘⇧W</span>
          </button>
        </div>
      )}

      {killConfirm && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
          onClick={() => setKillConfirm(false)}
        >
          <div
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-md shadow-2xl w-[440px] max-w-[92vw] p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <ShieldAlert size={18} className="text-red-400" />
              <span className="text-sm font-semibold text-white">
                终止 {tab.peerHostname} 上的 "{tab.title}"？
              </span>
            </div>
            <div className="text-[12.5px] text-gray-300">
              此操作会在远端 kill 这个 PTY 进程，所有未保存的会话状态将丢失。
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setKillConfirm(false)}
                className="px-3 py-1.5 text-[12px] text-gray-300 hover:bg-panel-hover rounded"
              >
                取消
              </button>
              <button
                onClick={handleCloseOnHost}
                className="px-3 py-1.5 text-[12px] text-white bg-red-600 hover:bg-red-700 rounded"
              >
                Close on Host
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Cleanup hook used by App.tsx when a remote tab is closed locally. Keeps
// the host PTY alive (per §8.4) — only killRemoteTab terminates it.
export function destroyRemoteTerminal(
  tabId: string,
  localSessionId: string,
  opts?: { silent?: boolean }
) {
  const instance = remoteTerminals.get(tabId)
  if (instance) {
    instance.term.dispose()
    remoteTerminals.delete(tabId)
  }
  // Fire-and-forget; closeRemoteTab is idempotent backend-side.
  window.electronAPI.remote.mesh.closeRemoteTab(localSessionId).catch(() => {})

  // Surface the "still running on host" nudge unless muted. We do this from
  // here rather than the component because the tab component unmounts
  // immediately on close.
  if (!opts?.silent) {
    const store = useRemoteStore.getState()
    if (!store.toasts.remoteTabCloseMuted) {
      store.pushToast({
        kind: 'remote-tab-closed',
        title: 'Remote Tab 已关闭',
        body: '此终端仍在远端上运行，可随时重新连接查看。',
      })
    }
  }
}
