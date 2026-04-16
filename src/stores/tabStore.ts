import { create } from 'zustand'

export type TabType = 'terminal' | 'editor'

export interface Tab {
  id: string
  type: TabType
  title: string
  cwd: string // every tab belongs to a workspace directory
  // For editor tabs
  filePath?: string
  fileContent?: string
  language?: string
  isDirty?: boolean
}

interface TabStore {
  tabs: Tab[]
  activeTabId: string | null

  addTerminalTab: (cwd: string) => string
  addEditorTab: (cwd: string, filePath: string, content: string, language: string) => void
  setActiveTab: (id: string) => void
  closeTab: (id: string) => void
  updateTabContent: (id: string, content: string) => void
  markTabClean: (id: string) => void
  updateTabTitle: (id: string, title: string) => void
  getActiveTab: () => Tab | undefined
}

let counter = 0
function genId() {
  return `tab-${Date.now()}-${++counter}`
}

function getLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp',
    h: 'c', hpp: 'cpp', css: 'css', scss: 'scss', html: 'html', json: 'json',
    yaml: 'yaml', yml: 'yaml', md: 'markdown', sql: 'sql', sh: 'shell',
    bash: 'shell', zsh: 'shell', toml: 'toml', xml: 'xml', swift: 'swift',
    kt: 'kotlin', rb: 'ruby', php: 'php', vue: 'vue', svelte: 'svelte',
  }
  return map[ext] || 'plaintext'
}

function folderName(cwd: string) {
  return cwd.split('/').pop() || cwd
}

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTerminalTab: (cwd: string) => {
    const id = genId()
    const termCount = get().tabs.filter((t) => t.type === 'terminal' && t.cwd === cwd).length + 1
    const name = folderName(cwd)
    const tab: Tab = {
      id,
      type: 'terminal',
      title: termCount === 1 ? name : `${name} (${termCount})`,
      cwd,
    }
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }))
    return id
  },

  addEditorTab: (cwd, filePath, content, language) => {
    const { tabs } = get()
    const existing = tabs.find((t) => t.filePath === filePath)
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }

    const name = filePath.split('/').pop() || filePath
    const id = genId()
    const tab: Tab = {
      id,
      type: 'editor',
      title: name,
      cwd,
      filePath,
      fileContent: content,
      language: language || getLanguage(name),
      isDirty: false,
    }
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }))
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  closeTab: (id) =>
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === id)
      const newTabs = state.tabs.filter((t) => t.id !== id)
      let newActive = state.activeTabId
      if (state.activeTabId === id) {
        if (newTabs.length > 0) {
          const newIdx = Math.min(idx, newTabs.length - 1)
          newActive = newTabs[newIdx].id
        } else {
          newActive = null
        }
      }
      return { tabs: newTabs, activeTabId: newActive }
    }),

  updateTabContent: (id, content) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, fileContent: content, isDirty: true } : t)),
    })),

  markTabClean: (id) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, isDirty: false } : t)),
    })),

  updateTabTitle: (id, title) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    })),

  getActiveTab: () => {
    const { tabs, activeTabId } = get()
    return tabs.find((t) => t.id === activeTabId)
  },
}))
