import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // Get absolute file path from a dropped File object
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // File system
  fs: {
    readDir: (dirPath: string) => ipcRenderer.invoke('fs:readDir', dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
    writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content),
    stat: (filePath: string) => ipcRenderer.invoke('fs:stat', filePath),
    rename: (oldPath: string, newPath: string) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
    delete: (filePath: string) => ipcRenderer.invoke('fs:delete', filePath),
    newFile: (filePath: string) => ipcRenderer.invoke('fs:newFile', filePath),
    newFolder: (dirPath: string) => ipcRenderer.invoke('fs:newFolder', dirPath),
  },

  // Dialogs
  dialog: {
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
  },

  // Shell
  showInFinder: (filePath: string) => ipcRenderer.invoke('shell:showInFinder', filePath),

  // Shell
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // Claude Code CLI
  claude: {
    query: (params: { prompt: string; cwd: string; conversationId: string; sessionId?: string }) =>
      ipcRenderer.invoke('claude:query', params),
    abort: (conversationId: string) => ipcRenderer.invoke('claude:abort', conversationId),
    onEvent: (callback: (data: any) => void) => {
      const listener = (_event: any, data: any) => callback(data)
      ipcRenderer.on('claude:event', listener)
      return () => ipcRenderer.removeListener('claude:event', listener)
    },
    onDone: (callback: (data: any) => void) => {
      const listener = (_event: any, data: any) => callback(data)
      ipcRenderer.on('claude:done', listener)
      return () => ipcRenderer.removeListener('claude:done', listener)
    },
    onError: (callback: (data: any) => void) => {
      const listener = (_event: any, data: any) => callback(data)
      ipcRenderer.on('claude:error', listener)
      return () => ipcRenderer.removeListener('claude:error', listener)
    },
  },

  // Terminal (multi-instance, keyed by tabId)
  terminal: {
    create: (tabId: string, cwd: string) => ipcRenderer.invoke('terminal:create', tabId, cwd),
    write: (tabId: string, data: string) => ipcRenderer.invoke('terminal:write', tabId, data),
    resize: (tabId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', tabId, cols, rows),
    dispose: (tabId: string) => ipcRenderer.invoke('terminal:dispose', tabId),
    onData: (tabId: string, callback: (data: string) => void) => {
      const channel = `terminal:data:${tabId}`
      const listener = (_event: any, data: string) => callback(data)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (tabId: string, callback: () => void) => {
      const channel = `terminal:exit:${tabId}`
      const listener = () => callback()
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
  },

  // Debug
  onDebugLog: (callback: (data: { source: string; message: string }) => void) => {
    const listener = (_e: any, data: any) => callback(data)
    ipcRenderer.on('debug:log', listener)
    return () => ipcRenderer.removeListener('debug:log', listener)
  },
})
