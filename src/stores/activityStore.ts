import { create } from 'zustand'

// How long a file stays highlighted after being touched (ms)
const HIGHLIGHT_DURATION = 3500

interface ActivityStore {
  // workspace cwd → (path → expires-at timestamp)
  touchedByWorkspace: Map<string, Map<string, number>>
  markTouched: (workspaceCwd: string, path: string) => void
  getTouched: (workspaceCwd: string) => Map<string, number>
  prune: () => number // returns ms until next prune needed, or 0 if nothing left
}

export const useActivityStore = create<ActivityStore>((set, get) => ({
  touchedByWorkspace: new Map(),

  markTouched: (workspaceCwd, path) => {
    const expires = Date.now() + HIGHLIGHT_DURATION
    set((state) => {
      const next = new Map(state.touchedByWorkspace)
      const wsMap = new Map(next.get(workspaceCwd) || [])
      wsMap.set(path, expires)
      next.set(workspaceCwd, wsMap)
      return { touchedByWorkspace: next }
    })
    scheduleNextPrune()
  },

  getTouched: (workspaceCwd) => {
    return get().touchedByWorkspace.get(workspaceCwd) || new Map()
  },

  prune: () => {
    const now = Date.now()
    let nextExpiry = Infinity
    let changed = false
    const next = new Map<string, Map<string, number>>()

    for (const [cwd, paths] of get().touchedByWorkspace) {
      const filtered = new Map<string, number>()
      for (const [p, exp] of paths) {
        if (exp > now) {
          filtered.set(p, exp)
          if (exp < nextExpiry) nextExpiry = exp
        } else {
          changed = true
        }
      }
      if (filtered.size > 0) {
        next.set(cwd, filtered)
      } else if (paths.size > 0) {
        changed = true
      }
    }

    if (changed) set({ touchedByWorkspace: next })
    return nextExpiry === Infinity ? 0 : nextExpiry - now
  },
}))

let pruneTimer: number | null = null

function scheduleNextPrune() {
  if (pruneTimer) return
  pruneTimer = window.setTimeout(() => {
    pruneTimer = null
    const nextDelay = useActivityStore.getState().prune()
    if (nextDelay > 0) {
      pruneTimer = window.setTimeout(() => {
        pruneTimer = null
        useActivityStore.getState().prune()
        scheduleNextPrune()
      }, nextDelay + 50)
    }
  }, HIGHLIGHT_DURATION + 100)
}
