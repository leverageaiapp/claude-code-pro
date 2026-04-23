interface BufferEntry {
  seq: number
  data: string
}

interface TabBuffer {
  entries: BufferEntry[]
  nextSeq: number
  totalDropped: number
}

const MAX_BUFFER_SIZE = 5000
const BUFFER_TRIM_SIZE = 3000

const CLEAR_SCREEN_RE = /\x1b\[[23]J|\x1bc/
const CLEAR_SCREEN_GLOBAL_RE = /\x1b\[[23]J|\x1bc/g

export interface HistoryResult {
  data: string[]
  lastSeq: number
  truncated: boolean
}

export class OutputBuffer {
  private tabs = new Map<string, TabBuffer>()

  private getOrCreate(tabId: string): TabBuffer {
    let buf = this.tabs.get(tabId)
    if (!buf) {
      buf = { entries: [], nextSeq: 1, totalDropped: 0 }
      this.tabs.set(tabId, buf)
    }
    return buf
  }

  append(tabId: string, data: string): { seq: number } {
    const buf = this.getOrCreate(tabId)
    const seq = buf.nextSeq++
    buf.entries.push({ seq, data })

    if (CLEAR_SCREEN_RE.test(data)) {
      const matches = [...data.matchAll(CLEAR_SCREEN_GLOBAL_RE)]
      const last = matches[matches.length - 1]
      const after = data.slice(last.index! + last[0].length)
      buf.totalDropped += buf.entries.length - (after ? 1 : 0)
      buf.entries = after ? [{ seq, data: after }] : []
    } else if (buf.entries.length > MAX_BUFFER_SIZE) {
      const dropCount = buf.entries.length - BUFFER_TRIM_SIZE
      buf.entries = buf.entries.slice(dropCount)
      buf.totalDropped += dropCount
    }

    return { seq }
  }

  getHistory(tabId: string): HistoryResult {
    const buf = this.tabs.get(tabId)
    if (!buf || buf.entries.length === 0) {
      return { data: [], lastSeq: buf?.nextSeq ? buf.nextSeq - 1 : 0, truncated: (buf?.totalDropped ?? 0) > 0 }
    }
    return {
      data: buf.entries.map((e) => e.data),
      lastSeq: buf.entries[buf.entries.length - 1].seq,
      truncated: buf.totalDropped > 0,
    }
  }

  getDelta(tabId: string, sinceSeq: number): HistoryResult | null {
    const buf = this.tabs.get(tabId)
    if (!buf || buf.entries.length === 0) {
      return { data: [], lastSeq: buf?.nextSeq ? buf.nextSeq - 1 : sinceSeq, truncated: false }
    }
    const bufferStart = buf.entries[0].seq
    if (sinceSeq < bufferStart - 1) {
      return null
    }
    const delta = buf.entries.filter((e) => e.seq > sinceSeq)
    return {
      data: delta.map((e) => e.data),
      lastSeq: delta.length > 0 ? delta[delta.length - 1].seq : sinceSeq,
      truncated: false,
    }
  }

  dropTab(tabId: string): void {
    this.tabs.delete(tabId)
  }
}
