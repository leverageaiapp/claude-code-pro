import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type TabType = 'terminal' | 'editor' | 'remote-terminal'

export type EditorViewMode = 'preview' | 'source'

export type RemoteTerminalStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'peer-exited'

export interface Tab {
  id: string
  type: TabType
  title: string
  cwd: string // every tab belongs to a workspace directory (remote tabs: a display-only hint)
  // For editor tabs
  filePath?: string
  fileContent?: string
  language?: string
  isDirty?: boolean
  viewMode?: EditorViewMode // only for markdown files; preview by default

  // For remote-terminal tabs
  peerHostname?: string
  peerSessionId?: string
  peerTabId?: string
  localSessionId?: string
  remoteStatus?: RemoteTerminalStatus
}

// Discriminated helper for the remote-terminal shape — used by the
// RemoteTerminal component where the fields are required.
export interface RemoteTerminalTab extends Tab {
  type: 'remote-terminal'
  peerHostname: string
  peerSessionId: string
  peerTabId: string
  localSessionId: string
  status: RemoteTerminalStatus
}

// Narrow-cast helper. Safer than `as RemoteTerminalTab` scattered in UI
// code because it centralises the invariant.
export function asRemoteTab(tab: Tab): RemoteTerminalTab | null {
  if (
    tab.type !== 'remote-terminal' ||
    !tab.peerHostname ||
    !tab.peerSessionId ||
    !tab.peerTabId ||
    !tab.localSessionId
  ) {
    return null
  }
  return {
    ...tab,
    type: 'remote-terminal',
    peerHostname: tab.peerHostname,
    peerSessionId: tab.peerSessionId,
    peerTabId: tab.peerTabId,
    localSessionId: tab.localSessionId,
    status: tab.remoteStatus ?? 'connecting',
  }
}

interface AddRemoteTabArgs {
  peerHostname: string
  peerSessionId: string
  peerTabId: string
  peerTabTitle: string
  localSessionId: string
}

interface TabStore {
  tabs: Tab[]
  activeTabId: string | null

  addTerminalTab: (cwd: string) => string
  addEditorTab: (cwd: string, filePath: string, content: string, language: string) => void
  addRemoteTab: (args: AddRemoteTabArgs) => string
  setActiveTab: (id: string) => void
  closeTab: (id: string) => void
  updateTabContent: (id: string, content: string) => void
  markTabClean: (id: string) => void
  updateTabTitle: (id: string, title: string) => void
  setTabViewMode: (id: string, mode: EditorViewMode) => void
  updateRemoteTabStatus: (id: string, status: RemoteTerminalStatus) => void
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

export const useTabStore = create<TabStore>()(
  persist(
    (set, get) => ({
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

  addRemoteTab: (args) => {
    const id = genId()
    const tab: Tab = {
      id,
      type: 'remote-terminal',
      title: `🌐 ${args.peerHostname} · ${args.peerTabTitle}`,
      cwd: args.peerHostname, // not a real cwd; shown as a hint only
      peerHostname: args.peerHostname,
      peerSessionId: args.peerSessionId,
      peerTabId: args.peerTabId,
      localSessionId: args.localSessionId,
      remoteStatus: 'connecting',
    }
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }))
    return id
  },

  updateRemoteTabStatus: (id, status) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, remoteStatus: status } : t)),
    })),

  addEditorTab: (cwd, filePath, content, language) => {
    const { tabs } = get()
    const existing = tabs.find((t) => t.filePath === filePath)
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }

    const name = filePath.split('/').pop() || filePath
    const id = genId()
    const resolvedLanguage = language || getLanguage(name)
    const tab: Tab = {
      id,
      type: 'editor',
      title: name,
      cwd,
      filePath,
      fileContent: content,
      language: resolvedLanguage,
      isDirty: false,
      viewMode: resolvedLanguage === 'markdown' ? 'preview' : undefined,
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

  setTabViewMode: (id, mode) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, viewMode: mode } : t)),
    })),

  getActiveTab: () => {
    const { tabs, activeTabId } = get()
    return tabs.find((t) => t.id === activeTabId)
  },
    }),
    {
      name: 'claude-code-pro:tabs',
      storage: createJSONStorage(() => localStorage),
      // Only persist the serializable parts. Terminal tabs rehydrate
      // with a fresh pty spawned at the same cwd when the component
      // mounts; editor tabs keep their last-seen content + dirty flag.
      partialize: (state) => ({
        // Drop remote-terminal tabs on persist — the session id / local
        // session id they reference belong to an old main-process mesh
        // session that no longer exists after restart. Users reconnect
        // from the sidebar or the Mesh tab. Local terminal + editor tabs
        // are rehydratable (pty respawned at same cwd; editor contents
        // kept with dirty flag).
        tabs: state.tabs.filter((t) => t.type !== 'remote-terminal'),
        activeTabId: state.activeTabId,
      }),
      // After rehydration, bump the id counter past anything we just
      // loaded so newly created tabs can't collide with persisted ids.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        for (const t of state.tabs) {
          const match = t.id.match(/^tab-\d+-(\d+)$/)
          if (match) counter = Math.max(counter, parseInt(match[1], 10))
        }
      },
    },
  ),
)
