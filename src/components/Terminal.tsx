import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal as XTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { debug } from '../stores/debugStore'

interface TerminalPanelProps {
  tabId: string
  cwd: string
  isActive: boolean
}

// Keep terminal instances alive across re-renders
const terminalInstances = new Map<
  string,
  { term: XTerminal; fit: FitAddon; created: boolean }
>()

export function TerminalPanel({ tabId, cwd, isActive }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return

    let instance = terminalInstances.get(tabId)

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
        new WebLinksAddon((_event, uri) => {
          debug('Terminal', `Link clicked: ${uri}`)
          window.electronAPI.shell.openExternal(uri).catch((err) => {
            debug('Terminal', `openExternal failed: ${err}`, 'error')
          })
        })
      )
      instance = { term, fit, created: false }
      terminalInstances.set(tabId, instance)
    }

    const { term, fit } = instance

    // Open in container
    if (containerRef.current.childElementCount === 0) {
      term.open(containerRef.current)
    }

    fit.fit()

    // Create PTY if not yet created
    if (!instance.created) {
      instance.created = true

      window.electronAPI.terminal.create(tabId, cwd).then((success) => {
        if (!success) {
          term.write('\r\n\x1b[31mFailed to create terminal\x1b[0m\r\n')
          return
        }

        // Track Shift key state
        let shiftHeld = false
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Shift') shiftHeld = true
        })
        document.addEventListener('keyup', (e) => {
          if (e.key === 'Shift') shiftHeld = false
        })

        term.onData((data) => {
          // Shift+Enter → send Option+Enter sequence (\x1b\r) which Claude Code treats as newline
          if (shiftHeld && data === '\r') {
            window.electronAPI.terminal.write(tabId, '\x1b\r')
            return
          }
          window.electronAPI.terminal.write(tabId, data)
        })

        window.electronAPI.terminal.onData(tabId, (data) => {
          term.write(data)
        })

        term.onResize(({ cols, rows }) => {
          window.electronAPI.terminal.resize(tabId, cols, rows)
        })

        // Clean up trailing whitespace on copy (xterm pads each line to terminal width)
        term.attachCustomKeyEventHandler((e) => {
          if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && e.key === 'c') {
            const sel = term.getSelection()
            if (sel) {
              const cleaned = sel
                .split('\n')
                .map((line) => line.replace(/\s+$/, ''))
                .join('\n')
                .replace(/\n+$/, '') // also trim trailing empty lines
              navigator.clipboard.writeText(cleaned).catch(() => {})
              return false // prevent xterm default copy
            }
          }
          return true
        })

        setTimeout(() => {
          fit.fit()
          window.electronAPI.terminal.resize(tabId, term.cols, term.rows)
        }, 100)
      })
    }

    // Handle resize
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
    }
  }, [tabId, cwd])

  // Re-fit when becoming active (needs delay for display:none → block transition)
  useEffect(() => {
    if (isActive) {
      const instance = terminalInstances.get(tabId)
      if (instance) {
        // Multiple attempts to ensure fit works after layout settles
        const delays = [0, 50, 150]
        const timers = delays.map((ms) =>
          setTimeout(() => {
            try {
              instance.fit.fit()
              window.electronAPI.terminal.resize(tabId, instance.term.cols, instance.term.rows)
              instance.term.focus()
            } catch {}
          }, ms)
        )
        return () => timers.forEach(clearTimeout)
      }
    }
  }, [isActive, tabId])

  const [isDragOver, setIsDragOver] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Use native DOM events on the wrapper to catch drag before xterm eats it
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      setIsDragOver(true)
    }

    const onDragLeave = (e: DragEvent) => {
      // Only trigger if leaving the wrapper entirely
      const related = e.relatedTarget as Node | null
      if (!wrapper.contains(related)) {
        setIsDragOver(false)
      }
    }

    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)

      // 1. Check if dragged from file tree (internal drag with path data)
      const filePath = e.dataTransfer?.getData('application/x-file-path')
      if (filePath) {
        const escaped = /[\s()'"]/.test(filePath) ? `"${filePath}"` : filePath
        window.electronAPI.terminal.write(tabId, escaped)
        return
      }

      // 2. External file drop (from Finder etc.)
      const files = e.dataTransfer?.files
      if (files && files.length > 0) {
        const paths = Array.from(files)
          .map((f) => {
            const p = window.electronAPI.getPathForFile(f)
            if (/[\s()'"]/.test(p)) {
              return `"${p}"`
            }
            return p
          })
          .join(' ')

        window.electronAPI.terminal.write(tabId, paths)
      }
    }

    wrapper.addEventListener('dragover', onDragOver)
    wrapper.addEventListener('dragleave', onDragLeave)
    wrapper.addEventListener('drop', onDrop)

    return () => {
      wrapper.removeEventListener('dragover', onDragOver)
      wrapper.removeEventListener('dragleave', onDragLeave)
      wrapper.removeEventListener('drop', onDrop)
    }
  }, [tabId])

  return (
    <div ref={wrapperRef} className="w-full h-full relative">
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ padding: '4px', background: '#1e1e1e' }}
      />
      {isDragOver && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-blue-500/15 border-2 border-dashed border-blue-500 rounded-lg"
          style={{ pointerEvents: 'all' }}
        >
          <span className="text-blue-400 text-sm font-medium bg-[#1e1e1e]/80 px-4 py-2 rounded-lg">
            Drop file to paste path
          </span>
        </div>
      )}
    </div>
  )
}

// Cleanup function for when a tab is closed
export function destroyTerminal(tabId: string) {
  const instance = terminalInstances.get(tabId)
  if (instance) {
    instance.term.dispose()
    terminalInstances.delete(tabId)
    window.electronAPI.terminal.dispose(tabId)
  }
}
