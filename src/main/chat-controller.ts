import type { ChatSnapshot } from '../shared/chat'
import { randomUUID } from 'node:crypto'
import { EventRecoveryGap, RunStartUncertain, type HermesClient } from './hermes-client'
export const PROGRESS_NOTICE = 'Still working on it…'
export class ChatController {
  snapshot: ChatSnapshot = { state: 'idle', user: '', answer: '', notice: '', busy: false, stopping: false, inputOpen: false }
  private run?: string
  private approval?: { id: string; request: string; run: string; spent: boolean }
  private settledApprovals = new Set<string>()
  private approvalTimer?: ReturnType<typeof setTimeout>
  private approvalDisarmed = false
  private generation = 0
  private streamAbort?: AbortController
  private activeTools = 0
  private resetPending = false
  private quietReset = false
  private speechText = ''
  private speechId = ''
  private speechInterim = false
  /** After this long with no new reply text, say so; then again every progressEveryMs. */
  progressAfterMs = 45_000
  progressEveryMs = 120_000
  /** The caption for a long quiet wait (the persona's own words). */
  progressNotice = PROGRESS_NOTICE
  private progressTimer?: ReturnType<typeof setTimeout>
  private lastReplyAt = 0
  private delegations = 0
  /** A long quiet wait; the origin decides whether it is also spoken. */
  onProgress?: (origin: 'text' | 'voice') => void
  /** A run finished; delegations counts the sub-agents it started (results may arrive later). */
  onCompleted?: (run: { output: string; delegations: number }) => void
  constructor(private client: Pick<HermesClient, 'start' | 'events' | 'stop'> & Partial<Pick<HermesClient, 'status' | 'approval' | 'resetSession' | 'prepareSession'>>, private changed: (snapshot: ChatSnapshot) => void) {}
  /** Warm the Hermes session while the user is still speaking/typing; failures surface on submit. */
  prepare() { if (!this.snapshot.busy) this.client.prepareSession?.().catch(() => {}) }
  private publish(update: Partial<ChatSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update }; this.changed({ ...this.snapshot })
  }
  toggleInput() { this.publish({ inputOpen: !this.snapshot.inputOpen }) }
  warn(notice: string) { this.publish({ notice }) }
  dismiss() { this.publish({ transcriptDismissed: true }) }
  async newConversation(quiet = false) {
    if (!this.client.resetSession) return
    this.quietReset = quiet
    this.resetPending = true
    if (this.snapshot.busy) await this.stop()
    else this.finishReset()
  }
  private finishReset() {
    if (!this.resetPending || this.snapshot.busy) return
    this.resetPending = false
    this.client.resetSession?.()
    this.publish({ transcriptDismissed: false, state: 'idle', speech: undefined, approval: undefined, user: '', answer: '', notice: this.quietReset ? '' : 'New conversation.' })
  }
  private clearApproval() {
    clearTimeout(this.approvalTimer)
    this.approvalTimer = undefined
    this.approval = undefined
  }
  private scheduleProgress(generation: number, delay: number) {
    clearTimeout(this.progressTimer)
    this.progressTimer = setTimeout(() => {
      if (generation !== this.generation || !this.snapshot.busy) return
      const quiet = Date.now() - this.lastReplyAt
      if (quiet < this.progressAfterMs) return this.scheduleProgress(generation, this.progressAfterMs - quiet)
      // An approval card or Stop already tells the user what is happening.
      if (!this.snapshot.approval && !this.snapshot.stopping) {
        this.publish({ notice: this.progressNotice })
        this.onProgress?.(this.snapshot.inputOrigin ?? 'text')
      }
      this.scheduleProgress(generation, this.progressEveryMs)
    }, delay)
    this.progressTimer.unref?.()
  }
  private finish(status: string, output?: unknown, notice?: string) {
    clearTimeout(this.progressTimer)
    this.generation++
    this.streamAbort?.abort()
    this.clearApproval()
    this.run = undefined
    this.publish({ speech: { id: this.speechId, text: typeof output === 'string' ? output : this.speechText, phase: status === 'completed' ? 'complete' : 'failed' }, approval: undefined, busy: false, stopping: false, state: ['completed', 'cancelled'].includes(status) ? 'idle' : 'offline',
      notice: status === 'completed' ? '' : status === 'cancelled' ? 'Stopped.' : notice || `Run ${status}.`,
      answer: status === 'completed' && typeof output === 'string' ? output.slice(0, 100_000) : this.snapshot.answer })
    if (status === 'completed') this.onCompleted?.({ output: typeof output === 'string' ? output : this.snapshot.answer, delegations: this.delegations })
    this.finishReset()
  }
  expireApproval(id: string) {
    if (this.approval?.id !== id) return
    void this.stop()
  }
  async respondApproval(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const payload = value as Record<string, unknown>
    if (Object.keys(payload).length !== 2 || typeof payload.id !== 'string' || typeof payload.choice !== 'string' || !['once', 'deny'].includes(payload.choice)) return
    const approval = this.approval
    if (!approval || approval.id !== payload.id || approval.run !== this.run || approval.spent || this.snapshot.stopping || !this.client.approval) return
    approval.spent = true
    this.publish({ approval: { ...this.snapshot.approval!, pending: true }, notice: 'Sending decision… awaiting backend confirmation.' })
    try { await this.client.approval(approval.run, approval.request, payload.choice as 'once' | 'deny') }
    catch {
      if (this.approval !== approval) return
      this.approvalDisarmed = true
      this.clearApproval()
      this.publish({ approval: undefined, state: 'offline', notice: 'Approval delivery is uncertain. No retry or additional grant; Stop before continuing.' })
    }
  }
  async submit(text: unknown, inputOrigin: 'text' | 'voice' = 'text') {
    if (this.snapshot.busy || typeof text !== 'string' || !text.trim() || text.length > 8000) return
    const generation = ++this.generation
    this.speechId = randomUUID()
    this.speechText = ''
    this.speechInterim = false
    this.streamAbort = new AbortController()
    this.publish({ inputOrigin, transcriptDismissed: false, speech: { id: this.speechId, text: '', phase: 'stream' }, state: 'thinking', busy: true, stopping: false, user: text.trim(), answer: '', notice: '' })
    this.settledApprovals.clear()
    this.approvalDisarmed = false
    this.activeTools = 0
    this.delegations = 0
    this.lastReplyAt = Date.now()
    this.scheduleProgress(generation, this.progressAfterMs)
    try {
      this.run = await this.client.start(text.trim())
      // Start the confirmation stream while Stop/readback are in flight. A
      // slow status request must not prevent terminal SSE confirmation.
      if (this.snapshot.stopping) void this.stop()
      if (generation !== this.generation) return
      for await (const { data } of this.client.events(this.run!, this.streamAbort.signal)) {
        if (generation !== this.generation) return
        if (data.run_id !== undefined && data.run_id !== this.run) continue
        // Deltas are provisional: Hermes can later identify them as interim.
        // Never feed interim/tool/permission payloads into the speech channel.
        if (['message.interim', 'tool.started', 'subagent.start', 'approval.request'].includes(String(data.event))) {
          this.speechInterim = true
          this.speechText = ''
          this.snapshot = { ...this.snapshot, speech: { id: this.speechId, text: '', phase: 'interim' } }
        }
        switch (data.event) {
          case 'approval.request':
            if (this.approvalDisarmed) break
            if (typeof data.request_id !== 'string' || !data.request_id || typeof data.command !== 'string' || !data.command.trim() || data.command.length > 2000 || this.snapshot.stopping) {
              await this.stop(); break
            }
            if (this.settledApprovals.has(data.request_id) || this.approval?.request === data.request_id) break
            if (this.approval) { await this.stop(); break }
            this.approval = { id: randomUUID(), request: data.request_id, run: this.run, spent: false }
            const cardId = this.approval.id
            this.approvalTimer = setTimeout(() => this.expireApproval(cardId), 120_000)
            this.approvalTimer.unref?.()
            this.publish({ state: 'approval', approval: { id: this.approval.id, action: data.command.slice(0, 2000), pending: false }, notice: 'Approval required. Only Approve once or Deny is available.' })
            break
          case 'approval.responded':
            if (this.approval && data.request_id === this.approval.request && (data.resolved === true || typeof data.resolved === 'number' && data.resolved > 0)) {
              this.settledApprovals.add(this.approval.request)
              this.clearApproval()
              this.publish({ approval: undefined, state: 'thinking', notice: 'Approval settled by backend.' })
            }
            break
          case 'tool.started': case 'subagent.start':
            if (data.event === 'tool.started' && data.tool === 'delegate_task') this.delegations++
            this.activeTools++
            this.publish({ state: 'working', notice: this.snapshot.stopping ? this.snapshot.notice : 'Using tools…' }); break
          case 'tool.completed': case 'subagent.complete':
            this.activeTools = Math.max(0, this.activeTools - 1)
            this.publish({ state: this.activeTools ? 'working' : 'thinking', notice: this.snapshot.stopping ? this.snapshot.notice : this.activeTools ? 'Using tools…' : '' }); break
          case 'message.delta': if (typeof data.delta === 'string') {
            this.speechText = (this.speechText + data.delta).slice(0, 100_001)
            this.lastReplyAt = Date.now()
            this.publish({ speech: { id: this.speechId, text: this.speechText.slice(0, 100_001), phase: this.speechInterim ? 'interim' : 'stream' }, answer: (this.snapshot.answer + data.delta).slice(0, 100_000), ...(this.snapshot.notice === this.progressNotice ? { notice: '' } : {}) })
          }; break
          case 'message.interim': this.publish(typeof data.text === 'string' && !data.already_streamed ? { answer: data.text.slice(0, 100_000) } : {}); break
          case 'run.completed':
            this.finish('completed', data.output)
            return
          case 'run.cancelled':
            this.finish('cancelled')
            return
          case 'run.failed': case 'run.interrupted':
            // orb_notice comes only from Orb's own OpenAI adapter, never from Hermes.
            this.finish(data.event === 'run.failed' ? 'failed' : 'interrupted', undefined, typeof data.orb_notice === 'string' ? data.orb_notice.slice(0, 300) : undefined)
            return
        }
      }
    } catch (error) {
      if (generation !== this.generation) return
      clearTimeout(this.progressTimer)
      this.clearApproval()
      this.publish({ approval: undefined })
      const uncertain = error instanceof RunStartUncertain
      this.publish({ state: 'offline', busy: !!this.run || uncertain, stopping: false, notice: error instanceof EventRecoveryGap ? 'Event recovery gap. Run status is uncertain; Stop before continuing.' : uncertain ? 'Run creation status is uncertain. Do not resend; check the gateway before restarting Orb.' : this.run ? 'Connection lost. Run status is uncertain; Stop before continuing.' : 'AI backend unavailable. Check that it is running and matches orb.config.json.' })
    }
  }
  async stop() {
    if (!this.snapshot.busy) return
    this.approvalDisarmed = true
    this.clearApproval()
    this.publish({ approval: undefined, stopping: true, notice: 'Stopping… awaiting confirmation.' })
    if (this.run) {
      const run = this.run
      try {
        await this.client.stop(run)
        if (this.client.status) for (let attempt = 0; attempt < 6; attempt++) {
          if (this.run !== run) return
          const result = await this.client.status(run)
          if (this.run !== run) return
          const status = result.status
          if (['completed', 'cancelled', 'failed', 'interrupted'].includes(String(status))) {
            this.finish(String(status), result.output)
            return
          }
          if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 200))
        }
        if (this.run === run && this.client.status) this.publish({ stopping: false, notice: 'Run is still active. Stop not yet confirmed; try Stop again.' })
      }
      catch { if (this.run === run) this.publish({ state: 'offline', stopping: false, notice: 'Stop could not be confirmed. Run may still be active.' }) }
    } else if (this.snapshot.state === 'offline') this.publish({ stopping: false, notice: 'Run ID is unknown. Stop cannot be confirmed; check the gateway before restarting Orb.' })
  }
  async recover() {
    const run = this.run
    if (!run || !this.client.status || this.snapshot.state !== 'offline') return
    try {
      const result = await this.client.status(run)
      if (this.run !== run) return
      if (result.run_id !== run) throw new Error('Foreign run status')
      if (['completed', 'cancelled', 'failed', 'interrupted'].includes(String(result.status))) this.finish(String(result.status), result.output)
      else this.publish({ notice: 'Gateway connected, but run is still active. Use Stop; no approval can be reconstructed safely.' })
    } catch { if (this.run === run) this.publish({ notice: 'Recovery could not confirm this run. Do not resend; try Stop or check gateway.' }) }
  }
}
