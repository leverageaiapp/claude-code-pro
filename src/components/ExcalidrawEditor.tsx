import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

import type { Tab } from '../stores/tabStore'
import { useTabStore } from '../stores/tabStore'

const SAVE_DEBOUNCE_MS = 500

interface Props {
  tab: Tab
}

export function ExcalidrawEditor({ tab }: Props) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const initialData = useMemo(() => {
    const empty = {
      elements: [],
      appState: { viewBackgroundColor: '#1e1e1e' },
      files: {},
    }
    if (!tab.fileContent || !tab.fileContent.trim()) return empty
    try {
      const parsed = JSON.parse(tab.fileContent)
      return {
        elements: parsed.elements || [],
        appState: { viewBackgroundColor: '#1e1e1e', ...(parsed.appState || {}) },
        files: parsed.files || {},
      }
    } catch {
      return empty
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  const handleChange = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (elements: any, appState: any, files: any) => {
      const filePath = tab.filePath
      if (!filePath) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        const json = serializeAsJSON(elements, appState, files, 'local')
        useTabStore.getState().updateTabContent(tab.id, json)
        window.electronAPI.fs.writeFile(filePath, json).then(() => {
          useTabStore.getState().markTabClean(tab.id)
        })
      }, SAVE_DEBOUNCE_MS)
    },
    [tab.id, tab.filePath],
  )

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  return (
    <div className="w-full h-full">
      <Excalidraw initialData={initialData} onChange={handleChange} theme="dark" />
    </div>
  )
}
