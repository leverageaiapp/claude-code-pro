import { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } from 'electron'
import path from 'path'
import fs from 'fs'
import { spawn, ChildProcess } from 'child_process'
import { PtyFanout, PtyHandle } from './remote/pty-fanout'
import { registerRemoteIpc, RemoteIpcHandles } from './remote/ipc'

let mainWindow: BrowserWindow | null = null
const fanout = new PtyFanout()
let remoteHandles: RemoteIpcHandles | null = null

// Store active Claude CLI processes per conversation
const claudeProcesses = new Map<string, ChildProcess>()

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const sendDebug = (msg: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('debug:log', { source: 'main', message: msg })
    }
  }

  mainWindow.webContents.on('will-navigate', (e, url) => {
    // Just prevent navigation — do NOT auto-open in browser, this can trigger
    // on HMR reloads and other internal navigations
    const devServerUrl = process.env.VITE_DEV_SERVER_URL || ''
    if (devServerUrl && url.startsWith(devServerUrl)) {
      return // allow HMR / internal reloads
    }
    sendDebug(`will-navigate blocked: ${url}`)
    e.preventDefault()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    sendDebug(`setWindowOpenHandler url: ${url}`)
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      sendDebug(`opened external: ${url}`)
      return { action: 'deny' }
    }
    // For about:blank etc, allow creation but hide and intercept
    if (url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        },
      }
    }
    return { action: 'deny' }
  })

  // When a child window is created (e.g., from window.open), intercept its navigation
  mainWindow.webContents.on('did-create-window', (childWindow) => {
    sendDebug('did-create-window')
    childWindow.webContents.on('will-navigate', (e, url) => {
      sendDebug(`child window will-navigate: ${url}`)
      e.preventDefault()
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url)
        sendDebug(`opened external from child: ${url}`)
      }
      childWindow.close()
    })
    // Also handle direct loads
    childWindow.webContents.on('will-redirect', (e, url) => {
      sendDebug(`child will-redirect: ${url}`)
      e.preventDefault()
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url)
      }
      childWindow.close()
    })
    // Close immediately if it just stays at about:blank with no navigation
    setTimeout(() => {
      if (!childWindow.isDestroyed()) {
        const url = childWindow.webContents.getURL()
        sendDebug(`child window after 100ms url: ${url}`)
        if (url && url !== 'about:blank' && (url.startsWith('http://') || url.startsWith('https://'))) {
          shell.openExternal(url)
        }
        childWindow.close()
      }
    }, 100)
  })

  // Catch any other navigation
  mainWindow.webContents.on('will-redirect', (_e, url) => {
    sendDebug(`will-redirect to: ${url}`)
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  // Keep the app alive when the lid is closed so pty sessions
  // (e.g. running `claude`) survive overnight sleep.
  powerSaveBlocker.start('prevent-app-suspension')
  createWindow()
  remoteHandles = registerRemoteIpc(fanout, () => mainWindow)
})

function cleanup() {
  claudeProcesses.forEach((proc) => {
    try { proc.kill() } catch {}
  })
  claudeProcesses.clear()
  for (const tabId of Array.from(ptyProcesses)) {
    fanout.kill(tabId)
  }
  ptyProcesses.clear()
  watchers.forEach((w) => {
    try { w.close() } catch {}
  })
  watchers.clear()
  if (remoteHandles) {
    void remoteHandles.shutdown()
    remoteHandles = null
  }
}

app.on('window-all-closed', () => {
  cleanup()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', cleanup)

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ===== File System IPC =====

ipcMain.handle('fs:readDir', async (_event, dirPath: string) => {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDirectory: e.isDirectory(),
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  } catch {
    return []
  }
})

ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8')
    return content
  } catch {
    return null
  }
})

ipcMain.handle('fs:writeFile', async (_event, filePath: string, content: string) => {
  try {
    await fs.promises.writeFile(filePath, content, 'utf-8')
    return true
  } catch {
    return false
  }
})

ipcMain.handle('fs:stat', async (_event, filePath: string) => {
  try {
    const stat = await fs.promises.stat(filePath)
    return { size: stat.size, isDirectory: stat.isDirectory(), mtime: stat.mtimeMs }
  } catch {
    return null
  }
})

ipcMain.handle('fs:rename', async (_event, oldPath: string, newPath: string) => {
  try {
    await fs.promises.rename(oldPath, newPath)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('fs:delete', async (_event, filePath: string) => {
  try {
    const stat = await fs.promises.stat(filePath)
    if (stat.isDirectory()) {
      await fs.promises.rm(filePath, { recursive: true })
    } else {
      await fs.promises.unlink(filePath)
    }
    return true
  } catch {
    return false
  }
})

ipcMain.handle('fs:newFile', async (_event, filePath: string) => {
  try {
    await fs.promises.writeFile(filePath, '', 'utf-8')
    return true
  } catch {
    return false
  }
})

ipcMain.handle('fs:newFolder', async (_event, dirPath: string) => {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true })
    return true
  } catch {
    return false
  }
})

ipcMain.handle('shell:showInFinder', async (_event, filePath: string) => {
  shell.showItemInFolder(filePath)
})

// ===== Dialog IPC =====

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

// ===== Shell IPC =====

ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  await shell.openExternal(url)
})

// ===== Claude Code CLI IPC =====

ipcMain.handle(
  'claude:query',
  async (_event, params: { prompt: string; cwd: string; conversationId: string; sessionId?: string }) => {
    const { prompt, cwd, conversationId, sessionId } = params

    // Kill existing process for this conversation
    const existing = claudeProcesses.get(conversationId)
    if (existing) {
      existing.kill()
      claudeProcesses.delete(conversationId)
    }

    return new Promise<void>((resolve) => {
      const args = ['--output-format', 'stream-json', '--verbose', '-p', prompt]

      // If we have a session ID from a previous turn, continue the conversation
      if (sessionId) {
        args.push('--session-id', sessionId)
      }

      const proc = spawn('claude', args, {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      claudeProcesses.set(conversationId, proc)

      let buffer = ''

      proc.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString()
        // Process complete JSON lines
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const event = JSON.parse(trimmed)
            mainWindow?.webContents.send('claude:event', { conversationId, event })
          } catch {
            // Not valid JSON, send as raw text
            mainWindow?.webContents.send('claude:event', {
              conversationId,
              event: { type: 'raw', text: trimmed },
            })
          }
        }
      })

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        mainWindow?.webContents.send('claude:event', {
          conversationId,
          event: { type: 'error', text },
        })
      })

      proc.on('close', (code) => {
        claudeProcesses.delete(conversationId)
        // Process remaining buffer
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer.trim())
            mainWindow?.webContents.send('claude:event', { conversationId, event })
          } catch {
            // ignore
          }
        }
        mainWindow?.webContents.send('claude:done', { conversationId, code })
        resolve()
      })

      proc.on('error', (err) => {
        claudeProcesses.delete(conversationId)
        mainWindow?.webContents.send('claude:error', {
          conversationId,
          error: err.message,
        })
        resolve()
      })
    })
  }
)

ipcMain.handle('claude:abort', async (_event, conversationId: string) => {
  const proc = claudeProcesses.get(conversationId)
  if (proc) {
    proc.kill('SIGINT')
    claudeProcesses.delete(conversationId)
    return true
  }
  return false
})

// ===== Terminal IPC (PTY) =====
// Multiple PTY instances keyed by tabId. Data routing goes through PtyFanout so
// remote share subscribers (local-server) see the same stream as the renderer.

const ptyProcesses = new Set<string>()

ipcMain.handle('terminal:create', async (_event, tabId: string, cwd: string) => {
  try {
    const pty = await import('node-pty')
    const shellPath =
      process.env.SHELL ||
      (process.platform === 'win32'
        ? process.env.COMSPEC || 'powershell.exe'
        : process.platform === 'darwin'
          ? '/bin/zsh'
          : '/bin/bash')

    const ptyProc = pty.spawn(shellPath, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: process.env as Record<string, string>,
    })

    ptyProcesses.add(tabId)

    fanout.registerTab(
      tabId,
      ptyProc as unknown as PtyHandle,
      (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(`terminal:data:${tabId}`, data)
        }
      },
    )

    // Notify renderer on exit. PtyFanout already clears buffer/subscribers for this tab.
    fanout.subscribe(
      tabId,
      () => {},
      () => {
        ptyProcesses.delete(tabId)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(`terminal:exit:${tabId}`)
        }
      },
    )

    // Auto-launch claude in new terminals
    setTimeout(() => {
      fanout.write(tabId, 'claude\r')
    }, 300)

    return true
  } catch (err: any) {
    console.error('Failed to create PTY:', err)
    return false
  }
})

ipcMain.handle('terminal:write', async (_event, tabId: string, data: string) => {
  fanout.write(tabId, data)
})

ipcMain.handle('terminal:resize', async (_event, tabId: string, cols: number, rows: number) => {
  fanout.resize(tabId, cols, rows)
})

ipcMain.handle('terminal:dispose', async (_event, tabId: string) => {
  if (ptyProcesses.has(tabId)) {
    ptyProcesses.delete(tabId)
    fanout.kill(tabId)
  }
})

// ===== File System Watcher (to detect Claude's edits) =====

const watchers = new Map<string, fs.FSWatcher>()

// Paths that we never want to report as "touched"
const IGNORED_PATTERNS = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)dist-electron(\/|$)/,
  /(^|\/)release(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)\.turbo(\/|$)/,
  /(^|\/)\.cache(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)out(\/|$)/,
  /(^|\/)\.DS_Store$/,
  /\.log$/,
  /\.lock$/,
]

function shouldIgnore(relativePath: string): boolean {
  return IGNORED_PATTERNS.some((re) => re.test(relativePath))
}

ipcMain.handle('fsWatch:start', async (_event, watchId: string, cwd: string) => {
  // Stop existing watcher with same id
  watchers.get(watchId)?.close()

  try {
    const watcher = fs.watch(cwd, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      const relPath = filename.toString()
      if (shouldIgnore(relPath)) return

      const fullPath = path.join(cwd, relPath)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('fsWatch:event', {
          watchId,
          cwd,
          path: fullPath,
          eventType, // 'rename' | 'change'
        })
      }
    })
    watchers.set(watchId, watcher)
    return true
  } catch (err: any) {
    console.error(`Failed to watch ${cwd}:`, err)
    return false
  }
})

ipcMain.handle('fsWatch:stop', async (_event, watchId: string) => {
  const watcher = watchers.get(watchId)
  if (watcher) {
    watcher.close()
    watchers.delete(watchId)
  }
})
