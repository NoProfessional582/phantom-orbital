import { randomUUID } from 'node:crypto'
import { parseSse, type SseEvent } from './sse'
export class RunStartUncertain extends Error {}
export class EventRecoveryGap extends Error {}
class HermesHttpError extends Error {
  constructor(public status: number) { super(`Hermes HTTP ${status}`) }
}
export class HermesClient {
  private session?: string
  private pendingSession?: Promise<string>
  private sessionGeneration = 0
  resetSession() { this.session = undefined; this.pendingSession = undefined; this.sessionGeneration++ }
  /** Create the next session early (e.g. while the user is still speaking). Safe to call repeatedly. */
  prepareSession(): Promise<string> {
    if (this.session) return Promise.resolve(this.session)
    if (this.pendingSession) return this.pendingSession
    const generation = this.sessionGeneration
    const pending: Promise<string> = this.createSession().then(id => {
      if (generation === this.sessionGeneration) this.session = id
      return id
    }, error => {
      if (this.pendingSession === pending) this.pendingSession = undefined
      throw error
    })
    this.pendingSession = pending
    return pending
  }
  private async createSession() {
    const created = await (await this.request('/api/sessions', { method: 'POST', body: JSON.stringify({ title: `Hermes Orb voice/text ${randomUUID()}`, source: 'api_server' }) })).json()
    const id = created.session?.id ?? created.session?.session_id
    if (typeof id !== 'string' || !id) throw new Error('Invalid Hermes session')
    const confirmed = await (await this.request(`/api/sessions/${encodeURIComponent(id)}`)).json()
    if ((confirmed.session?.id ?? confirmed.session?.session_id) !== id) throw new Error('Invalid Hermes session readback')
    return id
  }
  constructor(private endpoint: string, private key: string, private transport: typeof fetch = fetch, private synthetic = false) {
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || !/^\/(?:p\/[A-Za-z0-9_-]+\/?)?$/.test(url.pathname)) throw new Error('Hermes endpoint must be loopback HTTP')
    if (!key || /[\r\n]/.test(key)) throw new Error('Missing Hermes API key')
    if (synthetic && (url.port === '8642' || !['orb-mock-only', 'synthetic-megan'].includes(key))) throw new Error('Synthetic client requires isolated fixture credentials and port')
    this.endpoint = url.origin + url.pathname.replace(/\/$/, '')
  }
  private async request(path: string, init: RequestInit = {}) {
    const response = await this.transport(this.endpoint + path, {
      ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${this.key}`, 'X-Hermes-Session-Key': 'hermes-orb-voice', 'Content-Type': 'application/json', ...init.headers }
    })
    if (!response.ok) { await response.body?.cancel(); throw new HermesHttpError(response.status) }
    return response
  }
  async start(text: string): Promise<string> {
    // /v1/capabilities is static API discovery; skills/tools load server-side per run.
    const session = await this.prepareSession()
    const init = { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ input: text, session_id: session }) }
    let response: Response
    try { response = await this.request('/v1/runs', init) }
    catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException) && !(error instanceof HermesHttpError && error.status >= 500)) throw error
      try { response = await this.request('/v1/runs', init) }
      catch { throw new RunStartUncertain('Run creation status is uncertain') }
    }
    let run: { run_id?: unknown }
    try { run = await response.json() } catch { throw new RunStartUncertain('Run creation status is uncertain') }
    if (!run || response.status !== 202 || typeof run.run_id !== 'string' || !run.run_id) throw new RunStartUncertain('Invalid Hermes run response')
    return run.run_id
  }
  async *events(run: string, signal?: AbortSignal): AsyncGenerator<SseEvent> {
    let lastId: string | undefined, sequence = -1
    let pendingDelta = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.request(`/v1/runs/${encodeURIComponent(run)}/events`, {
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000), headers: lastId ? { 'Last-Event-ID': lastId } : {}
        })
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Invalid Hermes stream')
        for await (const event of parseSse(response.body)) {
          if (event.data.run_id !== run) throw new Error('Mismatched Hermes run')
          if (event.data.event === 'replay.truncated') throw new EventRecoveryGap('Hermes event recovery gap')
          if (typeof event.data.seq === 'number') {
            if (event.data.seq <= sequence) continue
            sequence = event.data.seq
          }
          if (event.id) lastId = event.id
          if (event.data.event === 'message.delta' && typeof event.data.delta === 'string') {
            const text = this.redact(pendingDelta + event.data.delta)
            let held = 0
            for (let size = Math.min(this.key.length - 1, text.length); size > 0; size--) {
              if (text.endsWith(this.key.slice(0, size))) { held = size; break }
            }
            pendingDelta = held ? text.slice(-held) : ''
            event.data.delta = held ? text.slice(0, -held) : text
          }
          for (const field of ['text', 'output', 'command']) if (typeof event.data[field] === 'string') event.data[field] = this.redact(event.data[field] as string)
          if (pendingDelta && ['run.completed', 'run.cancelled', 'run.failed', 'run.interrupted'].includes(String(event.data.event)) && typeof event.data.output !== 'string') {
            yield { data: { event: 'message.delta', run_id: run, delta: this.redact(pendingDelta) } }
            pendingDelta = ''
          }
          yield event
          if (['run.completed', 'run.cancelled', 'run.failed', 'run.interrupted'].includes(String(event.data.event))) return
        }
      } catch (error) {
        if (signal?.aborted) throw error
        if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error
      }
    }
    throw new Error('Hermes stream disconnected; run status is uncertain')
  }
  async stop(run: string): Promise<void> {
    const response = await this.request(`/v1/runs/${encodeURIComponent(run)}/stop`, { method: 'POST', body: '{}' })
    await response.body?.cancel()
  }
  async approval(run: string, request: string, choice: 'once' | 'deny'): Promise<void> {
    if (!request || !['once', 'deny'].includes(choice)) throw new Error('Invalid approval decision')
    const result = await (await this.request(`/v1/runs/${encodeURIComponent(run)}/approval`, { method: 'POST', body: JSON.stringify({ choice, request_id: request }) })).json()
    if (result.run_id !== run || result.request_id !== request || result.choice !== choice || !(result.resolved === true || typeof result.resolved === 'number' && result.resolved > 0)) throw new Error('Invalid approval receipt')
  }
  async status(run: string): Promise<Record<string, unknown>> {
    const result = await (await this.request(`/v1/runs/${encodeURIComponent(run)}`)).json()
    if (result.run_id !== run || typeof result.status !== 'string') throw new Error('Invalid Hermes run status')
    if (typeof result.output === 'string') result.output = this.redact(result.output)
    return result
  }
  private redact(text: string) { return text.split(this.key).join('[redacted]') }
}
