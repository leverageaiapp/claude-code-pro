import { create } from 'zustand'

export interface DebugLog {
  id: number
  timestamp: number
  level: 'info' | 'warn' | 'error'
  source: string
  message: string
}

interface DebugStore {
  logs: DebugLog[]
  visible: boolean
  setVisible: (v: boolean) => void
  addLog: (level: DebugLog['level'], source: string, message: string) => void
  clear: () => void
}

let counter = 0

export const useDebugStore = create<DebugStore>((set) => ({
  logs: [],
  visible: false,
  setVisible: (v) => set({ visible: v }),
  addLog: (level, source, message) =>
    set((state) => ({
      logs: [
        ...state.logs.slice(-499), // keep last 500
        { id: ++counter, timestamp: Date.now(), level, source, message },
      ],
    })),
  clear: () => set({ logs: [] }),
}))

// Global helper, callable from anywhere
export function debug(source: string, message: string, level: DebugLog['level'] = 'info') {
  useDebugStore.getState().addLog(level, source, message)
}
