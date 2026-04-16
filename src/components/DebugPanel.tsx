import { useEffect, useRef } from 'react'
import { Copy, Trash2, X } from 'lucide-react'
import { useDebugStore } from '../stores/debugStore'

export function DebugPanel() {
  const { logs, visible, setVisible, clear } = useDebugStore()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (visible && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs, visible])

  if (!visible) return null

  const handleCopy = () => {
    const text = logs
      .map((l) => {
        const time = new Date(l.timestamp).toISOString().slice(11, 23)
        return `[${time}] [${l.level.toUpperCase()}] [${l.source}] ${l.message}`
      })
      .join('\n')
    navigator.clipboard.writeText(text)
  }

  return (
    <div className="absolute bottom-6 left-0 right-0 z-50 bg-[#1a1a1a] border-t-2 border-orange-500 flex flex-col" style={{ height: 200 }}>
      <div className="flex items-center justify-between px-3 py-1 bg-[#252526] border-b border-panel-border shrink-0">
        <span className="text-xs text-orange-400 font-semibold uppercase tracking-wider">Debug Console ({logs.length})</span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-300 hover:bg-panel-hover rounded"
            title="Copy all logs"
          >
            <Copy size={12} />
            Copy
          </button>
          <button
            onClick={clear}
            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-300 hover:bg-panel-hover rounded"
            title="Clear logs"
          >
            <Trash2 size={12} />
            Clear
          </button>
          <button
            onClick={() => setVisible(false)}
            className="p-1 hover:bg-panel-hover rounded"
            title="Close"
          >
            <X size={14} className="text-gray-400" />
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px]">
        {logs.length === 0 ? (
          <div className="text-gray-600">No logs yet</div>
        ) : (
          logs.map((log) => {
            const time = new Date(log.timestamp).toISOString().slice(11, 23)
            const color =
              log.level === 'error' ? 'text-red-400' : log.level === 'warn' ? 'text-yellow-400' : 'text-gray-300'
            return (
              <div key={log.id} className="flex gap-2 py-[1px]">
                <span className="text-gray-600 shrink-0">{time}</span>
                <span className="text-blue-400 shrink-0">[{log.source}]</span>
                <span className={`${color} break-all`}>{log.message}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
