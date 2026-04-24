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
  fsWatch: {
    start: (watchId: string, cwd: string) => Promise<boolean>
    stop: (watchId: string) => Promise<void>
    onEvent: (
      callback: (data: { watchId: string; cwd: string; path: string; eventType: string }) => void
    ) => () => void
  }
  terminal: {
    create: (tabId: string, cwd: string) => Promise<boolean>
    write: (tabId: string, data: string) => Promise<void>
    resize: (tabId: string, cols: number, rows: number) => Promise<void>
    dispose: (tabId: string) => Promise<void>
    onData: (tabId: string, callback: (data: string) => void) => () => void
    onExit: (tabId: string, callback: () => void) => () => void
  }
  remote: {
    share: {
      create: (
        tabId: string,
      ) => Promise<
        | { ok: true; shareId: string; token: string; url: string; tunnelUrl: string }
        | { ok: false; error: string }
      >
      stop: (shareId: string) => Promise<boolean>
      list: () => Promise<{ shares: RemoteShareInfo[]; tunnelUrl: string | null }>
      status: () => Promise<{
        tunnelUrl: string | null
        cloudflaredRunning: boolean
        shares: RemoteShareInfo[]
      }>
    }
    onEvent: (callback: (data: RemoteEvent) => void) => () => void

    // Mesh (Tailscale) — see REMOTE_NETWORKING.md §4, §8
    mesh: {
      // --- lifecycle / control plane ---
      join: (args?: {
        hostname?: string
        customControlURL?: string
      }) => Promise<{ ok: boolean; error?: string }>
      leave: () => Promise<{ ok: boolean; error?: string }>
      logout: () => Promise<{ ok: boolean; error?: string }>
      status: () => Promise<MeshStatus>
      peers: () => Promise<{ peers: MeshPeer[] }>

      // --- host mode ---
      hostEnable: () => Promise<{ ok: boolean; port?: number; error?: string }>
      hostDisable: () => Promise<{ ok: boolean; error?: string }>

      // --- settings ---
      setDeviceName: (name: string) => Promise<{ ok: boolean; error?: string }>
      setCustomControlURL: (url: string | null) => Promise<{ ok: boolean; error?: string }>

      // --- outbound peer sessions ---
      connectPeer: (
        peerHostname: string,
      ) => Promise<{ ok: boolean; sessionId?: string; error?: string }>
      disconnectPeer: (sessionId: string) => Promise<{ ok: boolean; error?: string }>
      listPeerTabs: (
        sessionId: string,
      ) => Promise<{ ok: boolean; tabs?: RemoteTabInfo[]; error?: string }>
      openRemoteTab: (
        sessionId: string,
        peerTabId: string,
      ) => Promise<{ ok: boolean; localSessionId?: string; error?: string }>
      writeRemoteTab: (localSessionId: string, data: string) => Promise<boolean>
      closeRemoteTab: (localSessionId: string) => Promise<boolean>
      killRemoteTab: (localSessionId: string) => Promise<{ ok: boolean; error?: string }>
      createRemoteTab: (
        sessionId: string,
        args?: { cwd?: string; command?: string },
      ) => Promise<{ ok: boolean; tab?: RemoteTabInfo; error?: string }>

      // --- events ---
      onEvent: (cb: (evt: MeshEvent) => void) => () => void
      onRemoteTabData: (
        localSessionId: string,
        cb: (chunk: MeshTabDataMsg) => void,
      ) => () => void
    }
  }
}

export interface RemoteShareInfo {
  shareId: string
  tabId: string
  createdAt: number
  connectedClients: number
}

export type RemoteEvent =
  | { type: 'share:created'; shareId: string; tabId: string; tunnelUrl?: string }
  | { type: 'share:stopped'; shareId: string }
  | { type: 'share:client-joined'; shareId: string; tabId: string; connectedClients: number }
  | { type: 'share:client-left'; shareId: string; tabId: string; connectedClients: number }
  | { type: 'tunnel:started'; tunnelUrl: string }
  | { type: 'tunnel:stopped' }
  | { type: 'tunnel:crashed'; code: number | null }

// --- Mesh types (Tailscale) ---

export type MeshIpnState = 'starting' | 'needs_login' | 'running' | 'stopped'

export interface MeshPeer {
  name: string
  ip: string
  online: boolean
  os?: string
  // NOTE: the backend does not currently expose whether a given peer has
  // host-mode enabled. UI treats all online peers as potentially connectable
  // and surfaces a friendly error if the connection fails because they are
  // client-only. Track TODO for v2.
}

export interface MeshStatus {
  ipnState: MeshIpnState
  tailnetIp: string
  hostname: string
  hostMode: boolean
  peers: MeshPeer[]
}

export interface RemoteTabInfo {
  id: string
  title: string
  kind?: string
  cwd?: string
}

// Backend mesh-ipc emits a single discriminated union. The shape is a flat
// record with optional fields (rather than a strict discriminated union in
// TypeScript) to match the runtime payload from `electron/remote/mesh-ipc.ts`
// — keep this in sync with MeshEvent there. We narrow in the store code.
export type MeshEvent =
  | { type: 'state'; state: MeshIpnState; tailnetIp?: string }
  | { type: 'auth_url'; url: string }
  | { type: 'peers'; peers: MeshPeer[] }
  | { type: 'host_mode'; enabled: boolean }
  | { type: 'peer_first_connect'; peerName: string }
  | { type: 'peer_disconnect'; sessionId: string }
  | { type: 'remote_tab_exit'; localSessionId: string; code: number }
  | { type: 'crashed'; code: number | null }
  | { type: 'error'; code?: string; message: string; sessionId?: string }
  | {
      type: 'connect_retry'
      peerHostname: string
      attempt: number
      maxAttempts: number
      waitMs: number
    }

// Per-localSessionId data channel — `remote:mesh:tab:data:<id>`.
export type MeshTabDataMsg =
  | { type: 'history'; data: string[]; lastSeq: number; truncated?: boolean }
  | { type: 'output'; seq: number; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; code: string; message?: string }

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
