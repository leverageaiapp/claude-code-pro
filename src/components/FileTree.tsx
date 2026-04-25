import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FileCode,
  FileJson,
  FileText,
  Image,
} from 'lucide-react'
import type { FileEntry } from '../types'
import { useFileStore } from '../stores/fileStore'
import { useTabStore } from '../stores/tabStore'
import { useActivityStore } from '../stores/activityStore'

// Helper to get cwd from file store
function useCurrentCwd() {
  return useFileStore((s) => s.cwd)
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'swift', 'rb'].includes(ext))
    return <FileCode size={16} className="text-blue-400 shrink-0" />
  if (['json', 'yaml', 'yml', 'toml'].includes(ext))
    return <FileJson size={16} className="text-yellow-400 shrink-0" />
  if (['md', 'txt', 'log'].includes(ext)) return <FileText size={16} className="text-gray-400 shrink-0" />
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext))
    return <Image size={16} className="text-green-400 shrink-0" />
  return <File size={16} className="text-gray-400 shrink-0" />
}

// ===== Context Menu =====

interface ContextMenuProps {
  x: number
  y: number
  entry: FileEntry
  onClose: () => void
  onRefresh: () => void
}

function ContextMenu({ x, y, entry, onClose, onRefresh }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  const handleCopyPath = () => {
    navigator.clipboard.writeText(entry.path)
    onClose()
  }

  const handleCopyName = () => {
    navigator.clipboard.writeText(entry.name)
    onClose()
  }

  const handleRevealInFinder = () => {
    window.electronAPI.showInFinder(entry.path)
    onClose()
  }

  const handleRename = () => {
    const newName = prompt('Rename to:', entry.name)
    if (newName && newName !== entry.name) {
      const parentDir = entry.path.substring(0, entry.path.lastIndexOf('/'))
      const newPath = `${parentDir}/${newName}`
      window.electronAPI.fs.rename(entry.path, newPath).then((ok) => {
        if (ok) onRefresh()
      })
    }
    onClose()
  }

  const handleDelete = () => {
    const confirmed = confirm(`Delete "${entry.name}"?`)
    if (confirmed) {
      window.electronAPI.fs.delete(entry.path).then((ok) => {
        if (ok) onRefresh()
      })
    }
    onClose()
  }

  const handleNewFile = () => {
    const dir = entry.isDirectory ? entry.path : entry.path.substring(0, entry.path.lastIndexOf('/'))
    const name = prompt('New file name:')
    if (name) {
      window.electronAPI.fs.newFile(`${dir}/${name}`).then((ok) => {
        if (ok) onRefresh()
      })
    }
    onClose()
  }

  const handleNewFolder = () => {
    const dir = entry.isDirectory ? entry.path : entry.path.substring(0, entry.path.lastIndexOf('/'))
    const name = prompt('New folder name:')
    if (name) {
      window.electronAPI.fs.newFolder(`${dir}/${name}`).then((ok) => {
        if (ok) onRefresh()
      })
    }
    onClose()
  }

  const items = [
    { label: 'Copy Path', action: handleCopyPath },
    { label: 'Copy Name', action: handleCopyName },
    { label: '---' },
    { label: 'New File...', action: handleNewFile },
    { label: 'New Folder...', action: handleNewFolder },
    { label: '---' },
    { label: 'Rename...', action: handleRename },
    { label: 'Delete', action: handleDelete, danger: true },
    { label: '---' },
    { label: 'Reveal in Finder', action: handleRevealInFinder },
  ]

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] bg-[#2d2d2d] border border-[#555] rounded-md shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y }}
    >
      {items.map((item, i) =>
        item.label === '---' ? (
          <div key={i} className="border-t border-[#555] my-1" />
        ) : (
          <button
            key={i}
            className={`w-full text-left px-3 py-1.5 text-[13px] hover:bg-[#094771] transition-colors ${
              (item as any).danger ? 'text-red-400' : 'text-gray-200'
            }`}
            onClick={(item as any).action}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  )
}

// ===== Tree Node =====

interface TreeNodeProps {
  entry: FileEntry
  depth: number
  onRefresh: () => void
}

const EMPTY_MAP: Map<string, number> = new Map()

function TreeNode({ entry, depth, onRefresh }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[]>([])
  const { addEditorTab } = useTabStore()
  const { activeTabId, tabs } = useTabStore()
  const currentCwd = useCurrentCwd()

  // Subscribe only to the slice we need, with stable empty fallback
  const touchedMap = useActivityStore((s) => s.touchedByWorkspace.get(currentCwd)) ?? EMPTY_MAP
  const isTouched = entry.isDirectory
    ? false
    : (touchedMap.get(entry.path) ?? 0) > Date.now()
  const ancestorTouched = entry.isDirectory && (() => {
    const prefix = entry.path.endsWith('/') ? entry.path : entry.path + '/'
    const now = Date.now()
    for (const [p, exp] of touchedMap) {
      if (exp > now && p.startsWith(prefix)) return true
    }
    return false
  })()

  const loadChildren = useCallback(async () => {
    if (entry.isDirectory) {
      const entries = await window.electronAPI.fs.readDir(entry.path)
      setChildren(entries)
    }
  }, [entry.path, entry.isDirectory])

  // Refresh children when onRefresh is called and expanded
  useEffect(() => {
    if (expanded && entry.isDirectory) {
      loadChildren()
    }
  }, [expanded])

  // Auto-refresh when a watched fs event hits a path inside this directory
  useEffect(() => {
    if (!expanded || !entry.isDirectory) return
    const prefix = entry.path.endsWith('/') ? entry.path : entry.path + '/'
    let timer: ReturnType<typeof setTimeout> | null = null
    const remove = window.electronAPI.fsWatch.onEvent(({ path }) => {
      if (!path.startsWith(prefix)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(loadChildren, 150)
    })
    return () => {
      if (timer) clearTimeout(timer)
      remove()
    }
  }, [expanded, entry.path, entry.isDirectory, loadChildren])

  const handleClick = async () => {
    if (entry.isDirectory) {
      if (!expanded) loadChildren()
      setExpanded(!expanded)
    } else {
      const content = await window.electronAPI.fs.readFile(entry.path)
      if (content !== null) {
        addEditorTab(currentCwd, entry.path, content, '')
      }
    }
  }

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const isActive = activeTab?.filePath === entry.path

  // Drag support — drag file from tree into terminal
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', entry.path)
    e.dataTransfer.setData('application/x-file-path', entry.path)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div>
      <div
        className={`file-tree-item flex items-center gap-1 py-[2px] cursor-pointer select-none relative ${
          isActive ? 'active' : ''
        } ${isTouched ? 'claude-touched' : ''} ${ancestorTouched && !isTouched ? 'claude-ancestor-touched' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
        draggable
        onDragStart={handleDragStart}
      >
        {entry.isDirectory ? (
          <>
            {expanded ? (
              <ChevronDown size={16} className="text-gray-400 shrink-0" />
            ) : (
              <ChevronRight size={16} className="text-gray-400 shrink-0" />
            )}
            {expanded ? (
              <FolderOpen size={16} className="text-yellow-500 shrink-0" />
            ) : (
              <Folder size={16} className="text-yellow-500 shrink-0" />
            )}
          </>
        ) : (
          <>
            <span className="w-4 shrink-0" />
            {getFileIcon(entry.name)}
          </>
        )}
        <span className="text-[13px] text-gray-300 truncate">{entry.name}</span>
        {(isTouched || ancestorTouched) && (
          <span
            className="ml-auto mr-2 w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0 claude-pulse"
            title={isTouched ? 'Recently edited by Claude' : 'Contains a file recently edited by Claude'}
          />
        )}
      </div>
      {expanded &&
        children.map((child) => (
          <TreeNode key={child.path} entry={child} depth={depth + 1} onRefresh={() => loadChildren()} />
        ))}
    </div>
  )
}

// ===== File Tree =====

export function FileTree() {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null)
  const { cwd, setCwd } = useFileStore()

  const loadRoot = useCallback(() => {
    if (cwd) {
      window.electronAPI.fs.readDir(cwd).then(setEntries)
    }
  }, [cwd])

  useEffect(() => {
    loadRoot()
  }, [loadRoot])

  // Auto-refresh root entries when a watched fs event hits this workspace
  useEffect(() => {
    if (!cwd) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const remove = window.electronAPI.fsWatch.onEvent(({ cwd: watchedCwd }) => {
      if (watchedCwd !== cwd) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(loadRoot, 150)
    })
    return () => {
      if (timer) clearTimeout(timer)
      remove()
    }
  }, [cwd, loadRoot])

  const handleContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }

  const handleOpenFolder = async () => {
    const folder = await window.electronAPI.dialog.openFolder()
    if (folder) {
      setCwd(folder)
    }
  }

  if (!cwd) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
        <p className="text-sm text-gray-500 text-center">No folder opened</p>
        <button
          onClick={handleOpenFolder}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
        >
          Open Folder
        </button>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto py-1" onContextMenu={(e) => e.preventDefault()}>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider truncate">
          {cwd.split('/').pop()}
        </span>
      </div>
      {entries.map((entry) => (
        <div key={entry.path} onContextMenu={(e) => handleContextMenu(e, entry)}>
          <TreeNode entry={entry} depth={0} onRefresh={loadRoot} />
        </div>
      ))}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          entry={contextMenu.entry}
          onClose={() => setContextMenu(null)}
          onRefresh={loadRoot}
        />
      )}
    </div>
  )
}
