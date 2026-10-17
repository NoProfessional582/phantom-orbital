import type { SessionMessage } from './hermes-client'

// Hermes runs a delegated sub-agent in the background. For API sessions it does
// not start a new agent turn when it finishes; it appends a delivery row to the
// session and leaves the next turn to the client. Orb reads the run's own
// dispatch rows, then watches the session for the matching deliveries.
interface Watch { pending: Map<string, number>; delivered: Set<string>; scanned: boolean; until: number }

const numeric = (id: string) => Number.isFinite(Number(id)) ? Number(id) : -1

export class BackgroundWatch {
  private watches = new Map<string, Watch>()
  private timer?: ReturnType<typeof setInterval>
  private polling = false
  constructor(
    private messages: (session: string) => Promise<SessionMessage[]>,
    private deliver: (text: string) => void,
    private busy: () => boolean,
    private everyMs = 30_000,
    private maxMs = 2 * 60 * 60 * 1000,
    private now = () => Date.now()
  ) {}

  get watching() { return this.watches.size }

  /** A run in this session just finished; delegations > 0 means it called delegate_task. */
  async completed(session: string, delegations: number) {
    if (delegations <= 0) return
    const watch = this.watches.get(session) ?? { pending: new Map(), delivered: new Set(), scanned: false, until: 0 }
    watch.scanned = false
    watch.until = this.now() + this.maxMs
    this.watches.set(session, watch)
    await this.scan(session, watch)
    if (this.watches.size) { this.timer ??= setInterval(() => void this.poll(), this.everyMs); this.timer.unref?.() }
  }

  private async scan(session: string, watch: Watch) {
    let messages: SessionMessage[]
    try { messages = await this.messages(session) } catch { return }
    if (!watch.scanned) {
      // This run's dispatches are the ones after its prompt, the newest real user row.
      const prompt = Math.max(-1, ...messages.filter(m => m.role === 'user' && !m.delivery).map(m => numeric(m.id)))
      for (const m of messages) if (m.dispatch && numeric(m.id) > prompt && !watch.pending.has(m.dispatch.delegation)) watch.pending.set(m.dispatch.delegation, m.dispatch.count)
      watch.scanned = true
    }
    // Matched by delegation id, so a result that landed before this scan still counts.
    for (const m of [...messages].sort((a, b) => numeric(a.id) - numeric(b.id))) {
      const d = m.delivery
      if (!d || watch.delivered.has(m.id) || !watch.pending.has(d.delegation)) continue
      watch.delivered.add(m.id)
      if (d.text) this.deliver(d.text)
      const left = watch.pending.get(d.delegation)! - d.units
      if (left > 0) watch.pending.set(d.delegation, left)
      else watch.pending.delete(d.delegation)
    }
    if (watch.scanned && !watch.pending.size) this.watches.delete(session)
  }

  async poll() {
    if (this.polling || this.busy()) return
    this.polling = true
    try {
      for (const [session, watch] of this.watches) {
        if (this.now() > watch.until) { this.watches.delete(session); continue }
        await this.scan(session, watch)
      }
    } finally {
      this.polling = false
      if (!this.watches.size) { clearInterval(this.timer); this.timer = undefined }
    }
  }

  stop() { clearInterval(this.timer); this.timer = undefined; this.watches.clear() }
}
