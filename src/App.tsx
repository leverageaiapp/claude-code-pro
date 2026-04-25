import { useState, useRef, useCallback, useEffect } from 'react'
import { FileTree } from './components/FileTree'
import { EditorPanel, destroyEditor } from './components/Editor'
import { TerminalPanel, destroyTerminal } from './components/Terminal'
import { RemoteTerminalPanel, destroyRemoteTerminal } from './components/RemoteTerminal'
import {
  PanelLeftClose,
  PanelLeftOpen,
  FolderOpen,
  Plus,
  X,
  Terminal,
  FileCode,
  Circle,
  Link2,
  Globe,
  ChevronRight,
  ChevronDown,
  Loader2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react'
import { useFileStore } from './stores/fileStore'
import { useTabStore, asRemoteTab } from './stores/tabStore'
import { useDebugStore, debug } from './stores/debugStore'
import { DebugPanel } from './components/DebugPanel'
import { RemoteModal, type RemoteModalTab } from './components/RemoteModal'
import { ToastStack } from './components/ToastStack'
import { useActivityStore } from './stores/activityStore'
import { useRemoteStore, isClaudeCodePeer } from './stores/remoteStore'
import { Bug } from 'lucide-react'
import type { MeshPeer, RemoteTabInfo } from './types'

function App() {
  const [showSidebar, setShowSidebar] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const { cwd, setCwd } = useFileStore()
  const { tabs, activeTabId, setActiveTab, closeTab, addTerminalTab, addRemoteTab } =
    useTabStore()
  const debugVisible = useDebugStore((s) => s.visible)
  const setDebugVisible = useDebugStore((s) => s.setVisible)
  const debugLogCount = useDebugStore((s) => s.logs.length)

  const [remoteModalOpen, setRemoteModalOpen] = useState(false)
  const [remoteModalTab, setRemoteModalTab] = useState<RemoteModalTab>('mesh')
  const remoteShareCount = useRemoteStore((s) => s.tunnel.shares.length)
  const mesh = useRemoteStore((s) => s.mesh)
  const openRemoteTabAction = useRemoteStore((s) => s.openRemoteTab)
  const pushToast = useRemoteStore((s) => s.pushToast)

  const activeTab = tabs.find((t) => t.id === activeTabId)

  // On mount: populate remote state from the backend (tunnel status + any
  // shares that survived a renderer reload, plus initial mesh status).
  useEffect(() => {
    useRemoteStore.getState().refreshStatus()
    useRemoteStore.getState().refreshMeshStatus()
    // Auto-join on start if the user asked for it and we're not already
    // on the tailnet. Fire-and-forget — errors surface via the normal
    // mesh event stream.
    const state = useRemoteStore.getState()
    if (state.mesh.autoJoinOnStart && !state.mesh.enabled) {
      void state.joinMesh()
    }
  }, [])

  // Register debug log listener (from main process)
  useEffect(() => {
    const remove = window.electronAPI.onDebugLog(({ source, message }) => {
      debug(source, message)
    })
    return remove
  }, [])

  // Subscribe to file system events — tag each by its workspace cwd
  useEffect(() => {
    const remove = window.electronAPI.fsWatch.onEvent(({ path, cwd: watchedCwd }) => {
      useActivityStore.getState().markTouched(watchedCwd, path)
    })
    return remove
  }, [])

  // Maintain one fs watcher per unique workspace cwd that has an open terminal tab.
  // This way Claude editing files in a background tab still gets recorded.
  useEffect(() => {
    const uniqueCwds = Array.from(
      new Set(tabs.filter((t) => t.type === 'terminal' && t.cwd).map((t) => t.cwd))
    )

    uniqueCwds.forEach((cwd) => {
      const watchId = `ws-${cwd}`
      window.electronAPI.fsWatch.start(watchId, cwd)
    })

    return () => {
      uniqueCwds.forEach((cwd) => {
        window.electronAPI.fsWatch.stop(`ws-${cwd}`)
      })
    }
  }, [tabs.map((t) => t.cwd).join('|')])

  // On first launch: prompt to open a folder if none exists
  useEffect(() => {
    if (tabs.length === 0 && !cwd) {
      window.electronAPI.dialog.openFolder().then((folder) => {
        if (folder) {
          setCwd(folder)
          addTerminalTab(folder)
        }
      })
    } else if (tabs.length === 0 && cwd) {
      addTerminalTab(cwd)
    }
  }, [])

  // When switching tabs, sync file tree to that tab's cwd
  useEffect(() => {
    if (activeTab?.cwd && activeTab.cwd !== cwd) {
      setCwd(activeTab.cwd)
    }
  }, [activeTabId])

  // Sidebar resize
  const isResizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const handleSidebarResize = useCallback(
    (e: React.MouseEvent) => {
      isResizing.current = true
      startX.current = e.clientX
      startWidth.current = sidebarWidth

      const onMove = (e: MouseEvent) => {
        if (!isResizing.current) return
        const delta = e.clientX - startX.current
        setSidebarWidth(Math.max(160, Math.min(500, startWidth.current + delta)))
      }
      const onUp = () => {
        isResizing.current = false
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [sidebarWidth]
  )

  const handleCloseTab = (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId)
    if (tab?.type === 'terminal') {
      destroyTerminal(tabId)
    } else if (tab?.type === 'remote-terminal' && tab.localSessionId) {
      // Keeps the host PTY alive (only killRemoteTab tears it down).
      destroyRemoteTerminal(tabId, tab.localSessionId)
    } else {
      destroyEditor(tabId)
    }
    closeTab(tabId)
  }

  // Shared handler for "I want to open a remote tab on peer X" — used both
  // by RemoteModal (full picker) and the sidebar quick-connect.
  const handleOpenRemoteTab = useCallback(
    async (args: {
      sessionId: string
      peerHostname: string
      peerTab: RemoteTabInfo
    }) => {
      const res = await openRemoteTabAction(args.sessionId, args.peerTab.id)
      if (!res.ok || !res.localSessionId) {
        pushToast({
          kind: 'error',
          title: 'Could not open remote tab',
          body: res.error ?? 'Unknown error',
          ttlMs: 6000,
        })
        return
      }
      addRemoteTab({
        peerHostname: args.peerHostname,
        peerSessionId: args.sessionId,
        peerTabId: args.peerTab.id,
        peerTabTitle: args.peerTab.title || args.peerTab.id,
        localSessionId: res.localSessionId,
      })
    },
    [openRemoteTabAction, pushToast, addRemoteTab]
  )

  // "+" button: pick a folder, then open a new terminal in it
  const handleAddTab = async () => {
    const folder = await window.electronAPI.dialog.openFolder()
    if (folder) {
      setCwd(folder)
      addTerminalTab(folder)
    }
  }

  // Title bar "Open Folder" button: open in current tab's context or new tab
  const handleOpenFolder = async () => {
    const folder = await window.electronAPI.dialog.openFolder()
    if (folder) {
      setCwd(folder)
      addTerminalTab(folder)
    }
  }

  return (
    <div className="h-screen flex flex-col bg-panel-bg text-white select-none overflow-hidden">
      {/* Title Bar */}
      <div className="titlebar-drag h-10 flex items-center justify-between px-3 bg-[#323233] border-b border-panel-border shrink-0">
        <div className="flex items-center gap-1 pl-[70px]">
          <button
            onClick={() => setShowSidebar(!showSidebar)}
            className="titlebar-no-drag p-1.5 hover:bg-[#555] rounded transition-colors"
            title="Toggle Sidebar"
          >
            {showSidebar ? (
              <PanelLeftClose size={16} className="text-gray-400" />
            ) : (
              <PanelLeftOpen size={16} className="text-gray-400" />
            )}
          </button>
          <button
            onClick={handleOpenFolder}
            className="titlebar-no-drag p-1.5 hover:bg-[#555] rounded transition-colors"
            title="Open Folder"
          >
            <FolderOpen size={16} className="text-gray-400" />
          </button>
        </div>

        <div className="text-xs text-gray-400">
          {activeTab?.cwd ? activeTab.cwd.split('/').pop() : 'Claude Code Pro'}
        </div>

        <div className="flex items-center gap-1">
          <MeshIndicator
            onClick={() => {
              setRemoteModalTab('mesh')
              setRemoteModalOpen(true)
            }}
            state={mesh.status}
            enabled={mesh.enabled}
            hostMode={mesh.hostMode}
            pendingAuth={!!mesh.authUrl}
          />
          <button
            onClick={() => {
              setRemoteModalTab('tunnel')
              setRemoteModalOpen(true)
            }}
            className={`titlebar-no-drag relative p-1.5 rounded transition-colors ${
              remoteShareCount > 0
                ? 'bg-blue-600/30 text-blue-300'
                : 'hover:bg-[#555] text-gray-400'
            }`}
            title="Share terminal via link"
          >
            <Link2 size={14} />
            {remoteShareCount > 0 && (
              <span className="absolute -top-[2px] -right-[2px] min-w-[14px] h-[14px] px-[3px] bg-blue-500 text-white text-[9px] font-mono font-semibold rounded-full flex items-center justify-center leading-none">
                {remoteShareCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setDebugVisible(!debugVisible)}
            className={`titlebar-no-drag p-1.5 rounded transition-colors flex items-center gap-1 ${
              debugVisible ? 'bg-orange-600/30 text-orange-400' : 'hover:bg-[#555] text-gray-400'
            }`}
            title="Toggle Debug Console"
          >
            <Bug size={14} />
            {debugLogCount > 0 && (
              <span className="text-[10px] font-mono">{debugLogCount}</span>
            )}
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {showSidebar && (
          <>
            <div
              className="shrink-0 bg-panel-sidebar border-r border-panel-border overflow-y-auto flex flex-col"
              style={{ width: sidebarWidth }}
            >
              {mesh.enabled && (
                <MyDevicesSection
                  peers={mesh.peers}
                  onOpenRemoteTab={handleOpenRemoteTab}
                />
              )}
              <div className="flex-1 min-h-0">
                <FileTree />
              </div>
            </div>
            <div
              className="resize-handle w-[3px] cursor-col-resize shrink-0 bg-panel-border hover:bg-blue-500 transition-colors"
              onMouseDown={handleSidebarResize}
            />
          </>
        )}

        {/* Main Area: Tabs + Content */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Tab Bar */}
          <div className="flex items-center bg-[#252526] border-b border-panel-border shrink-0">
            <div className="flex flex-1 overflow-x-auto">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`group flex items-center gap-1.5 px-3 py-[6px] cursor-pointer border-r border-panel-border text-[13px] min-w-0 shrink-0 ${
                    tab.id === activeTabId
                      ? 'bg-panel-bg text-white border-t-2 border-t-blue-500'
                      : 'text-gray-400 hover:bg-panel-hover border-t-2 border-t-transparent'
                  }`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.type === 'terminal' ? (
                    <Terminal size={14} className="text-green-400 shrink-0" />
                  ) : tab.type === 'remote-terminal' ? (
                    <Globe size={14} className="text-green-400 shrink-0" />
                  ) : (
                    <FileCode size={14} className="text-blue-400 shrink-0" />
                  )}
                  <span className="truncate max-w-[160px]">{tab.title}</span>
                  {tab.isDirty && <Circle size={6} className="text-white fill-white shrink-0" />}
                  <button
                    className="opacity-0 group-hover:opacity-100 hover:bg-[#555] rounded p-[2px] shrink-0 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleCloseTab(tab.id)
                    }}
                  >
                    <X size={14} className="text-gray-400" />
                  </button>
                </div>
              ))}
            </div>

            {/* Add Tab Button */}
            <button
              onClick={handleAddTab}
              className="p-2 hover:bg-panel-hover transition-colors shrink-0"
              title="New Terminal (pick folder)"
            >
              <Plus size={16} className="text-gray-400" />
            </button>
          </div>

          {/* Tab Content */}
          <div className="flex-1 min-h-0 overflow-hidden relative">
            {tabs.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center text-gray-500 max-w-md">
                  <Terminal size={48} className="mx-auto mb-4 text-gray-600" />
                  <h2 className="text-lg text-gray-300 mb-2">Welcome to Claude Code Pro</h2>
                  <p className="text-sm mb-6">Open a folder to start a new workspace</p>
                  <button
                    onClick={handleAddTab}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm transition-colors"
                  >
                    Open Folder
                  </button>
                </div>
              </div>
            ) : (
              tabs.map((tab) => (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  style={{
                    visibility: tab.id === activeTabId ? 'visible' : 'hidden',
                    zIndex: tab.id === activeTabId ? 1 : 0,
                  }}
                >
                  {tab.type === 'terminal' ? (
                    <TerminalPanel tabId={tab.id} cwd={tab.cwd} isActive={tab.id === activeTabId} />
                  ) : tab.type === 'remote-terminal' ? (
                    (() => {
                      const rt = asRemoteTab(tab)
                      if (!rt) {
                        return (
                          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                            Remote tab is missing session info — please close and reconnect.
                          </div>
                        )
                      }
                      return <RemoteTerminalPanel tab={rt} isActive={tab.id === activeTabId} />
                    })()
                  ) : (
                    <EditorPanel tab={tab} isActive={tab.id === activeTabId} />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <DebugPanel />
      <RemoteModal
        open={remoteModalOpen}
        onClose={() => setRemoteModalOpen(false)}
        initialTab={remoteModalTab}
        onOpenRemoteTab={handleOpenRemoteTab}
      />
      <ToastStack />

      {/* Status Bar */}
      <div className="h-6 flex items-center justify-between px-3 bg-[#007acc] text-white text-[11px] shrink-0">
        <div className="flex items-center gap-3">
          <span>{activeTab?.cwd || cwd || 'No folder'}</span>
        </div>
        <div className="flex items-center gap-3">
          <span>
            {activeTab?.type === 'terminal' ? 'Terminal' : activeTab?.title || ''}
          </span>
        </div>
      </div>
    </div>
  )
}

export default App

// ---------- Title-bar mesh indicator ----------

interface MeshIndicatorProps {
  onClick: () => void
  state: 'starting' | 'needs_login' | 'running' | 'stopped'
  enabled: boolean
  hostMode: boolean
  pendingAuth: boolean
}

function MeshIndicator({
  onClick,
  state,
  enabled,
  hostMode,
  pendingAuth,
}: MeshIndicatorProps) {
  // Tri-state per §8.1:
  //   - gray: not joined
  //   - green single-ring: joined, client-only
  //   - gold double-ring: joined, host mode
  //   - yellow pulse: starting / needs_login
  const running = state === 'running'
  const pulsing = state === 'starting' || pendingAuth

  let color = 'text-gray-400'
  let ring = ''
  let title = 'Mesh (not joined)'
  if (!enabled) {
    color = 'text-gray-400'
    title = 'Mesh (not joined)'
  } else if (pulsing) {
    color = 'text-amber-400 animate-pulse'
    title = 'Mesh connecting…'
  } else if (running && hostMode) {
    color = 'text-amber-400'
    ring = 'ring-2 ring-offset-1 ring-offset-[#323233] ring-amber-400'
    title = 'Mesh (Host mode — accepting connections)'
  } else if (running) {
    color = 'text-green-400'
    ring = 'ring-1 ring-offset-1 ring-offset-[#323233] ring-green-400/70'
    title = 'Mesh (client-only)'
  }

  return (
    <button
      onClick={onClick}
      className={`titlebar-no-drag p-1.5 rounded transition-colors hover:bg-[#555] ${ring ? 'relative' : ''}`}
      title={title}
    >
      <span className={`inline-flex ${ring} rounded-full p-0.5`}>
        <Globe size={14} className={color} />
      </span>
    </button>
  )
}

// ---------- Sidebar My Devices section (§8.3) ----------
//
// Each online peer is a persistent, expandable node — VS Code Remote-SSH
// style: one connection per host stays alive while the app runs, the user
// can see the host's open tabs live, click any to attach, or spawn a new
// tab on the host without leaving the sidebar.

function MyDevicesSection({
  peers,
  onOpenRemoteTab,
}: {
  peers: MeshPeer[]
  onOpenRemoteTab: (args: {
    sessionId: string
    peerHostname: string
    peerTab: RemoteTabInfo
  }) => Promise<void> | void
}) {
  const [sectionExpanded, setSectionExpanded] = useState(true)
  // Only show peers that look like claude-code-pro nodes; hide the rest of
  // the user's tailnet (phones, routers, other servers) which would
  // ECONNREFUSED on port 4242.
  const appPeers = peers.filter(isClaudeCodePeer)
  return (
    <div className="border-b border-panel-border shrink-0">
      <button
        onClick={() => setSectionExpanded((v) => !v)}
        className="w-full flex items-center gap-1 px-2 py-1.5 text-[11px] uppercase tracking-wide text-gray-400 hover:bg-panel-hover"
      >
        {sectionExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Globe size={11} className="text-green-400" />
        <span>Remote Hosts</span>
        <span className="ml-auto text-gray-500 lowercase">({appPeers.length})</span>
      </button>
      {sectionExpanded && (
        <div className="pb-1">
          {appPeers.length === 0 ? (
            <div className="px-3 py-1 text-[11px] text-gray-500 italic">
              No peers visible
            </div>
          ) : (
            appPeers.map((peer) => (
              <PeerRow
                key={peer.name}
                peer={peer}
                onOpenRemoteTab={onOpenRemoteTab}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// One row per peer. Manages its own expanded state and lazily ensures the
// underlying MeshClientSession on first expand.
function PeerRow({
  peer,
  onOpenRemoteTab,
}: {
  peer: MeshPeer
  onOpenRemoteTab: (args: {
    sessionId: string
    peerHostname: string
    peerTab: RemoteTabInfo
  }) => Promise<void> | void
}) {
  const [expanded, setExpanded] = useState(false)
  const [showNewTabForm, setShowNewTabForm] = useState(false)
  const [newTabBusy, setNewTabBusy] = useState(false)

  const session = useRemoteStore((s) => s.mesh.peerSessions[peer.name])
  const ensurePeerSession = useRemoteStore((s) => s.ensurePeerSession)
  const refreshPeerTabs = useRemoteStore((s) => s.refreshPeerTabs)
  const createTabOnPeer = useRemoteStore((s) => s.createTabOnPeer)
  const pushToast = useRemoteStore((s) => s.pushToast)

  // Lazy connect on first expand. Re-running on re-expand after a previous
  // failure is intentional — ensurePeerSession is idempotent for live
  // sessions and treats error/disconnected as "retry".
  useEffect(() => {
    if (!expanded || !peer.online) return
    void ensurePeerSession(peer.name)
  }, [expanded, peer.name, peer.online, ensurePeerSession])

  const status = session?.status
  const tabs = session?.tabs ?? []

  const handleToggle = () => {
    if (!peer.online) return
    setExpanded((v) => {
      const next = !v
      // Collapsing should hide the new-tab form so the next expand starts
      // clean rather than mid-form.
      if (!next) setShowNewTabForm(false)
      return next
    })
  }

  const handleNewTab = async (cwd: string, command: string) => {
    if (!peer.online) return
    setNewTabBusy(true)
    try {
      const res = await createTabOnPeer(peer.name, {
        cwd: cwd.trim() || undefined,
        command: command.trim() || undefined,
      })
      if (!res.ok || !res.tab) {
        pushToast({
          kind: 'error',
          title: `Could not create tab on ${peer.name}`,
          body: res.error ?? 'Unknown error',
          ttlMs: 6000,
        })
        return
      }
      // Mirror VS Code Remote-SSH "Open Folder" — after spawning the tab on
      // the host, also attach to it locally so the user can immediately
      // start typing in it.
      const cur = useRemoteStore.getState().mesh.peerSessions[peer.name]
      if (cur?.sessionId) {
        await onOpenRemoteTab({
          sessionId: cur.sessionId,
          peerHostname: peer.name,
          peerTab: res.tab,
        })
      }
      setShowNewTabForm(false)
    } finally {
      setNewTabBusy(false)
    }
  }

  return (
    <div>
      <div
        className={`group w-full flex items-center gap-1.5 px-2 py-1 text-[12px] ${
          peer.online ? 'text-gray-200' : 'text-gray-500'
        }`}
      >
        <button
          onClick={handleToggle}
          disabled={!peer.online}
          className={`flex items-center gap-1 flex-1 min-w-0 text-left ${
            peer.online ? 'hover:bg-panel-hover cursor-pointer' : 'cursor-not-allowed'
          } rounded px-1 py-[2px] -mx-1`}
          title={peer.online ? `Expand ${peer.name}` : `${peer.name} is offline`}
        >
          {peer.online ? (
            expanded ? (
              <ChevronDown size={11} className="text-gray-400 shrink-0" />
            ) : (
              <ChevronRight size={11} className="text-gray-400 shrink-0" />
            )
          ) : (
            <span className="w-[11px] shrink-0" />
          )}
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              peer.online ? 'bg-green-500' : 'bg-gray-500'
            }`}
          />
          <span className="truncate">{peer.name}</span>
          {expanded && status === 'connecting' && (
            <Loader2 size={11} className="text-gray-400 animate-spin shrink-0" />
          )}
          {expanded && status === 'error' && (
            <AlertCircle size={11} className="text-red-400 shrink-0" />
          )}
        </button>
        {expanded && peer.online && status === 'connected' && (
          <button
            onClick={() => refreshPeerTabs(peer.name)}
            className="opacity-0 group-hover:opacity-100 p-[3px] hover:bg-panel-hover rounded transition-opacity shrink-0"
            title="Refresh tabs"
          >
            <RefreshCw size={11} className="text-gray-400" />
          </button>
        )}
      </div>
      {expanded && peer.online && (
        <div className="ml-[18px] border-l border-panel-border pl-1.5 pb-1">
          {status === 'connecting' && (
            <div className="text-[11px] text-gray-500 italic px-2 py-1">
              Connecting…
            </div>
          )}
          {status === 'error' && (
            <div className="px-2 py-1 space-y-1">
              <div className="text-[11px] text-red-400/80">
                {session?.error ?? 'Connection failed'}
              </div>
              <button
                onClick={() => ensurePeerSession(peer.name)}
                className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1"
              >
                <RefreshCw size={10} />
                <span>Retry</span>
              </button>
            </div>
          )}
          {status === 'connected' && tabs.length === 0 && (
            <div className="text-[11px] text-gray-500 italic px-2 py-1">
              No tabs on this device
            </div>
          )}
          {status === 'connected' &&
            tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  if (!session?.sessionId) return
                  void onOpenRemoteTab({
                    sessionId: session.sessionId,
                    peerHostname: peer.name,
                    peerTab: t,
                  })
                }}
                className="w-full flex items-center gap-1.5 px-2 py-[3px] text-left text-[12px] text-gray-200 hover:bg-panel-hover rounded transition-colors"
                title={t.cwd || t.title}
              >
                <Terminal size={11} className="text-green-400 shrink-0" />
                <span className="truncate">{t.title || t.id}</span>
                {t.cwd && (
                  <span className="ml-auto text-[10px] text-gray-500 truncate max-w-[100px]">
                    {basenameOrPath(t.cwd)}
                  </span>
                )}
              </button>
            ))}
          {status === 'connected' && (
            <div className="pt-1">
              {showNewTabForm ? (
                <NewTabForm
                  busy={newTabBusy}
                  onCancel={() => setShowNewTabForm(false)}
                  onSubmit={handleNewTab}
                />
              ) : (
                <button
                  onClick={() => setShowNewTabForm(true)}
                  className="w-full flex items-center gap-1.5 px-2 py-[3px] text-left text-[11px] text-gray-400 hover:bg-panel-hover hover:text-gray-200 rounded transition-colors"
                >
                  <Plus size={11} />
                  <span>New tab on {peer.name}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function NewTabForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean
  onSubmit: (cwd: string, command: string) => void
  onCancel: () => void
}) {
  const [cwd, setCwd] = useState('')
  const [command, setCommand] = useState('')
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (busy) return
        onSubmit(cwd, command)
      }}
      className="px-2 py-1 space-y-1 bg-[#252526] rounded"
    >
      <input
        type="text"
        autoFocus
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
        placeholder="cwd (optional, e.g. ~/projects/foo)"
        className="w-full px-1.5 py-[2px] text-[11px] bg-[#1e1e1e] border border-[#3c3c3c] rounded text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        disabled={busy}
      />
      <input
        type="text"
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder="command (optional, default: shell)"
        className="w-full px-1.5 py-[2px] text-[11px] bg-[#1e1e1e] border border-[#3c3c3c] rounded text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        disabled={busy}
      />
      <div className="flex justify-end gap-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="px-2 py-[2px] text-[11px] text-gray-400 hover:bg-panel-hover rounded"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="px-2 py-[2px] text-[11px] text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
        >
          {busy && <Loader2 size={10} className="animate-spin" />}
          Open
        </button>
      </div>
    </form>
  )
}

function basenameOrPath(p: string): string {
  if (!p) return ''
  const trimmed = p.replace(/\/+$/, '')
  const last = trimmed.split('/').pop()
  return last || p
}
