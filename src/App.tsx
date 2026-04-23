import { useState, useRef, useCallback, useEffect } from 'react'
import { FileTree } from './components/FileTree'
import { EditorPanel, destroyEditor } from './components/Editor'
import { TerminalPanel, destroyTerminal } from './components/Terminal'
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
} from 'lucide-react'
import { useFileStore } from './stores/fileStore'
import { useTabStore } from './stores/tabStore'
import { useDebugStore, debug } from './stores/debugStore'
import { DebugPanel } from './components/DebugPanel'
import { RemoteModal } from './components/RemoteModal'
import { useActivityStore } from './stores/activityStore'
import { useRemoteStore } from './stores/remoteStore'
import { Bug } from 'lucide-react'

function App() {
  const [showSidebar, setShowSidebar] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const { cwd, setCwd } = useFileStore()
  const { tabs, activeTabId, setActiveTab, closeTab, addTerminalTab } = useTabStore()
  const debugVisible = useDebugStore((s) => s.visible)
  const setDebugVisible = useDebugStore((s) => s.setVisible)
  const debugLogCount = useDebugStore((s) => s.logs.length)

  const [remoteModalOpen, setRemoteModalOpen] = useState(false)
  const remoteShareCount = useRemoteStore((s) => s.tunnel.shares.length)

  const activeTab = tabs.find((t) => t.id === activeTabId)

  // On mount: populate remote state from the backend (tunnel status + any
  // shares that survived a renderer reload).
  useEffect(() => {
    useRemoteStore.getState().refreshStatus()
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
    } else {
      destroyEditor(tabId)
    }
    closeTab(tabId)
  }

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
          <button
            onClick={() => setRemoteModalOpen(true)}
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
              className="shrink-0 bg-panel-sidebar border-r border-panel-border overflow-hidden"
              style={{ width: sidebarWidth }}
            >
              <FileTree />
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
      <RemoteModal open={remoteModalOpen} onClose={() => setRemoteModalOpen(false)} />

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
