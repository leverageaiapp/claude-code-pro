export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  toolCalls?: ToolCall[]
  thinking?: string
}

export interface ToolCall {
  id: string
  name: string
  input: any
  status: 'running' | 'done' | 'error'
  output?: string
}

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  sessionId?: string
  createdAt: number
}

interface ElectronAPI {
  getPathForFile: (file: File) => string
  fs: {
    readDir: (dirPath: string) => Promise<FileEntry[]>
    readFile: (filePath: string) => Promise<string | null>
    writeFile: (filePath: string, content: string) => Promise<boolean>
    stat: (filePath: string) => Promise<{ size: number; isDirectory: boolean; mtime: number } | null>
    rename: (oldPath: string, newPath: string) => Promise<boolean>
    delete: (filePath: string) => Promise<boolean>
    newFile: (filePath: string) => Promise<boolean>
    newFolder: (dirPath: string) => Promise<boolean>
  }
  dialog: {
    openFolder: () => Promise<string | null>
    openFile: () => Promise<string | null>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
  }
  showInFinder: (filePath: string) => Promise<void>
  claude: {
    query: (params: { prompt: string; cwd: string; conversationId: string; sessionId?: string }) => Promise<void>
    abort: (conversationId: string) => Promise<boolean>
    onEvent: (callback: (data: any) => void) => () => void
    onDone: (callback: (data: any) => void) => () => void
    onError: (callback: (data: any) => void) => () => void
  }
  onDebugLog: (callback: (data: { source: string; message: string }) => void) => () => void
  terminal: {
    create: (tabId: string, cwd: string) => Promise<boolean>
    write: (tabId: string, data: string) => Promise<void>
    resize: (tabId: string, cols: number, rows: number) => Promise<void>
    dispose: (tabId: string) => Promise<void>
    onData: (tabId: string, callback: (data: string) => void) => () => void
    onExit: (tabId: string, callback: () => void) => () => void
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
