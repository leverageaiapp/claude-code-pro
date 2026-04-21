import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

interface OpenFile {
  path: string
  name: string
  content: string
  language: string
  isDirty: boolean
}

interface FileStore {
  cwd: string
  setCwd: (path: string) => void
  openFiles: OpenFile[]
  activeFilePath: string | null
  setActiveFile: (path: string) => void
  openFile: (path: string) => Promise<void>
  closeFile: (path: string) => void
  updateFileContent: (path: string, content: string) => void
  saveFile: (path: string) => Promise<void>
}

function getLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    css: 'css',
    scss: 'scss',
    html: 'html',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    toml: 'toml',
    xml: 'xml',
    swift: 'swift',
    kt: 'kotlin',
    rb: 'ruby',
    php: 'php',
    vue: 'vue',
    svelte: 'svelte',
  }
  return map[ext] || 'plaintext'
}

export const useFileStore = create<FileStore>()(
  persist(
    (set, get) => ({
  cwd: '',
  setCwd: (path) => set({ cwd: path }),

  openFiles: [],
  activeFilePath: null,

  setActiveFile: (path) => set({ activeFilePath: path }),

  openFile: async (filePath) => {
    const { openFiles } = get()
    // Already open
    if (openFiles.some((f) => f.path === filePath)) {
      set({ activeFilePath: filePath })
      return
    }
    const content = await window.electronAPI.fs.readFile(filePath)
    if (content === null) return
    const name = filePath.split('/').pop() || filePath
    const file: OpenFile = {
      path: filePath,
      name,
      content,
      language: getLanguage(name),
      isDirty: false,
    }
    set((state) => ({
      openFiles: [...state.openFiles, file],
      activeFilePath: filePath,
    }))
  },

  closeFile: (filePath) => {
    set((state) => {
      const newFiles = state.openFiles.filter((f) => f.path !== filePath)
      let newActive = state.activeFilePath
      if (state.activeFilePath === filePath) {
        newActive = newFiles.length > 0 ? newFiles[newFiles.length - 1].path : null
      }
      return { openFiles: newFiles, activeFilePath: newActive }
    })
  },

  updateFileContent: (filePath, content) => {
    set((state) => ({
      openFiles: state.openFiles.map((f) => (f.path === filePath ? { ...f, content, isDirty: true } : f)),
    }))
  },

  saveFile: async (filePath) => {
    const file = get().openFiles.find((f) => f.path === filePath)
    if (!file) return
    await window.electronAPI.fs.writeFile(filePath, file.content)
    set((state) => ({
      openFiles: state.openFiles.map((f) => (f.path === filePath ? { ...f, isDirty: false } : f)),
    }))
  },
    }),
    {
      name: 'claude-code-pro:workspace',
      storage: createJSONStorage(() => localStorage),
      // Only persist the workspace folder — openFiles is ephemeral
      // per-session state that re-reads from disk on open.
      partialize: (state) => ({ cwd: state.cwd }),
    },
  ),
)
