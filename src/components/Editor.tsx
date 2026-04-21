import { useEffect, useRef, useCallback } from 'react'
import * as monaco from 'monaco-editor'
import { Eye, Code2 } from 'lucide-react'
import type { Tab } from '../stores/tabStore'
import { useTabStore } from '../stores/tabStore'
import { MarkdownPreview } from './MarkdownPreview'
import { ExcalidrawEditor } from './ExcalidrawEditor'

// Configure Monaco workers
self.MonacoEnvironment = {
  getWorkerUrl(_moduleId: string, label: string) {
    if (label === 'json') return '/node_modules/monaco-editor/esm/vs/language/json/json.worker.js'
    if (label === 'css' || label === 'scss' || label === 'less')
      return '/node_modules/monaco-editor/esm/vs/language/css/css.worker.js'
    if (label === 'html' || label === 'handlebars' || label === 'razor')
      return '/node_modules/monaco-editor/esm/vs/language/html/html.worker.js'
    if (label === 'typescript' || label === 'javascript')
      return '/node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js'
    return '/node_modules/monaco-editor/esm/vs/editor/editor.worker.js'
  },
}

interface EditorPanelProps {
  tab: Tab
  isActive: boolean
}

// Store editor instances to keep state across tab switches
const editorInstances = new Map<string, monaco.editor.IStandaloneCodeEditor>()

export function EditorPanel({ tab, isActive }: EditorPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { updateTabContent, markTabClean, setTabViewMode } = useTabStore()

  const isExcalidraw = tab.filePath?.endsWith('.excalidraw') ?? false
  const isMarkdown = tab.language === 'markdown'
  const showPreview = isMarkdown && tab.viewMode === 'preview'

  const setupEditor = useCallback(() => {
    if (isExcalidraw) return
    if (!containerRef.current) return

    let editor = editorInstances.get(tab.id)

    if (!editor) {
      editor = monaco.editor.create(containerRef.current, {
        value: tab.fileContent || '',
        language: tab.language || 'plaintext',
        theme: 'vs-dark',
        fontSize: 14,
        fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
        fontLigatures: true,
        minimap: { enabled: true, scale: 1 },
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        renderWhitespace: 'selection',
        bracketPairColorization: { enabled: true },
        padding: { top: 8 },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        wordWrap: 'off',
      })

      editorInstances.set(tab.id, editor)

      // Track content changes
      editor.onDidChangeModelContent(() => {
        const value = editor!.getValue()
        updateTabContent(tab.id, value)
      })

      // Save shortcut
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        const currentTab = useTabStore.getState().tabs.find((t) => t.id === tab.id)
        if (currentTab?.filePath && currentTab.fileContent != null) {
          window.electronAPI.fs.writeFile(currentTab.filePath, currentTab.fileContent).then(() => {
            markTabClean(tab.id)
          })
        }
      })
    }

    // Layout when becoming active (but not when preview is covering the editor)
    if (isActive && !showPreview) {
      setTimeout(() => editor?.layout(), 50)
      editor.focus()
    }
  }, [tab.id, isActive, showPreview, isExcalidraw])

  useEffect(() => {
    setupEditor()
  }, [setupEditor])

  // Re-layout on active change or when leaving preview mode
  useEffect(() => {
    if (isExcalidraw) return
    if (isActive && !showPreview) {
      const editor = editorInstances.get(tab.id)
      if (editor) {
        setTimeout(() => {
          editor.layout()
          editor.focus()
        }, 50)
      }
    }
  }, [isActive, tab.id, showPreview, isExcalidraw])

  if (isExcalidraw) {
    return <ExcalidrawEditor tab={tab} />
  }

  return (
    <div className="relative w-full h-full">
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ visibility: showPreview ? 'hidden' : 'visible' }}
      />

      {showPreview && (
        <div className="absolute inset-0">
          <MarkdownPreview content={tab.fileContent || ''} />
        </div>
      )}

      {isMarkdown && (
        <div className="absolute top-2 right-4 z-10 flex items-center gap-1 bg-[#252526] border border-[#3c3c3c] rounded-md shadow-md overflow-hidden">
          <button
            type="button"
            onClick={() => setTabViewMode(tab.id, 'preview')}
            className={`flex items-center gap-1 px-2.5 py-1 text-[11px] transition-colors ${
              showPreview ? 'bg-[#37373d] text-white' : 'text-[#cccccc] hover:bg-[#2a2d2e]'
            }`}
            title="Preview"
          >
            <Eye size={12} />
            Preview
          </button>
          <button
            type="button"
            onClick={() => setTabViewMode(tab.id, 'source')}
            className={`flex items-center gap-1 px-2.5 py-1 text-[11px] transition-colors ${
              !showPreview ? 'bg-[#37373d] text-white' : 'text-[#cccccc] hover:bg-[#2a2d2e]'
            }`}
            title="Source"
          >
            <Code2 size={12} />
            Source
          </button>
        </div>
      )}
    </div>
  )
}

// Cleanup when tab is closed
export function destroyEditor(tabId: string) {
  const editor = editorInstances.get(tabId)
  if (editor) {
    editor.dispose()
    editorInstances.delete(tabId)
  }
}
