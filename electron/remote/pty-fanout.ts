import { OutputBuffer } from './output-buffer'

export interface PtyHandle {
  onData(cb: (data: string) => void): { dispose: () => void }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose: () => void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface FanoutEvent {
  type: 'data'
  seq: number
  data: string
}

export type FanoutListener = (evt: FanoutEvent) => void
export type ExitListener = (code: number) => void

interface TabEntry {
  pty: PtyHandle
  dataListeners: Set<FanoutListener>
  exitListeners: Set<ExitListener>
  dispose: () => void
}

export class PtyFanout {
  readonly buffer = new OutputBuffer()
  private tabs = new Map<string, TabEntry>()

  registerTab(tabId: string, pty: PtyHandle, rendererSend: (data: string) => void): void {
    if (this.tabs.has(tabId)) {
      this.unregisterTab(tabId)
    }

    const entry: TabEntry = {
      pty,
      dataListeners: new Set(),
      exitListeners: new Set(),
      dispose: () => {},
    }

    const dataSub = pty.onData((data: string) => {
      rendererSend(data)
      const { seq } = this.buffer.append(tabId, data)
      for (const listener of entry.dataListeners) {
        listener({ type: 'data', seq, data })
      }
    })

    const exitSub = pty.onExit((e) => {
      const code = e.exitCode ?? 0
      for (const listener of entry.exitListeners) {
        listener(code)
      }
      this.tabs.delete(tabId)
      // Tombstone the buffer instead of dropping it, so clients that
      // reconnect after PTY exit can still fetch history + see the exit.
      this.buffer.markExit(tabId, code)
    })

    entry.dispose = () => {
      dataSub.dispose()
      exitSub.dispose()
    }

    this.tabs.set(tabId, entry)
  }

  unregisterTab(tabId: string): void {
    const entry = this.tabs.get(tabId)
    if (!entry) return
    entry.dispose()
    entry.dataListeners.clear()
    entry.exitListeners.clear()
    this.tabs.delete(tabId)
    this.buffer.dropTab(tabId)
  }

  subscribe(tabId: string, onData: FanoutListener, onExit: ExitListener): () => void {
    const entry = this.tabs.get(tabId)
    if (!entry) {
      // Tab is gone. If we have a tombstoned exit, fire it so the caller's
      // exit pipeline runs the same way it would for a live-then-exited tab.
      const exit = this.buffer.getExit(tabId)
      if (exit) {
        queueMicrotask(() => onExit(exit.code))
      }
      return () => {}
    }
    entry.dataListeners.add(onData)
    entry.exitListeners.add(onExit)
    return () => {
      entry.dataListeners.delete(onData)
      entry.exitListeners.delete(onExit)
    }
  }

  write(tabId: string, data: string): void {
    this.tabs.get(tabId)?.pty.write(data)
  }

  resize(tabId: string, cols: number, rows: number): void {
    const entry = this.tabs.get(tabId)
    if (!entry) return
    try {
      entry.pty.resize(cols, rows)
    } catch {
      // ignore resize errors
    }
  }

  kill(tabId: string): void {
    const entry = this.tabs.get(tabId)
    if (!entry) return
    try {
      entry.pty.kill()
    } catch {
      // ignore
    }
    this.tabs.delete(tabId)
    this.buffer.dropTab(tabId)
  }

  hasTab(tabId: string): boolean {
    return this.tabs.has(tabId)
  }
}
