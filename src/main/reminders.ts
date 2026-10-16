import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Hermes reminder scripts hand off here instead of toasting while Orb is
// visible. They read presence.json; a fresh heartbeat with visible=true means
// "drop a JSON file in inbox/". Anything else falls back to a Windows toast.
export interface Reminder { id: string; title: string; message: string; url: string }
export const PRESENCE_INTERVAL_MS = 2000

export function parseReminder(raw: string): Reminder | undefined {
  let data: unknown
  try { data = JSON.parse(raw) } catch { return undefined }
  if (!data || typeof data !== 'object') return undefined
  const { title, message, url } = data as Record<string, unknown>
  if (typeof message !== 'string' || !message.trim()) return undefined
  const link = typeof url === 'string' && /^https?:\/\//i.test(url) ? url.slice(0, 2000) : ''
  return { id: randomUUID(), title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : 'Reminder', message: message.trim().slice(0, 2000), url: link }
}

export class ReminderInbox {
  private timer?: ReturnType<typeof setInterval>
  private lastPresence = 0
  readonly inbox: string
  readonly presence: string
  constructor(private dir: string, private visible: () => boolean, private deliver: (reminder: Reminder) => void, private now = () => Date.now()) {
    this.inbox = join(dir, 'inbox')
    this.presence = join(dir, 'presence.json')
  }
  start() {
    mkdirSync(this.inbox, { recursive: true })
    this.tick()
    this.timer = setInterval(() => this.tick(), 500)
    this.timer.unref?.()
  }
  stop() {
    clearInterval(this.timer)
    try { rmSync(this.presence, { force: true }) } catch { /* best effort */ }
  }
  /** Rewrite presence immediately, e.g. on show/hide/lock. */
  touch() {
    const tmp = `${this.presence}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify({ pid: process.pid, visible: this.visible(), updated: this.now() }))
      renameSync(tmp, this.presence)
      this.lastPresence = this.now()
    } catch { /* next tick retries */ }
  }
  tick() {
    if (this.now() - this.lastPresence >= PRESENCE_INTERVAL_MS) this.touch()
    let names: string[]
    try { names = readdirSync(this.inbox).filter(name => name.endsWith('.json')).sort() } catch { return }
    for (const name of names) {
      const path = join(this.inbox, name)
      let raw: string
      try { raw = readFileSync(path, 'utf8'); rmSync(path, { force: true }) } catch { continue }
      const reminder = parseReminder(raw)
      if (reminder) this.deliver(reminder)
    }
  }
}
