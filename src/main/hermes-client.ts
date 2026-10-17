import { randomUUID } from 'node:crypto'
import { parseSse, type SseEvent } from './sse'
export class RunStartUncertain extends Error {}
export class EventRecoveryGap extends Error {}
export interface SessionMessage {
  id: string; role: string; text: string; reply: boolean
  /** A delegate_task call that went to the background: its id and sub-agent count. */
  dispatch?: { delegation: string; count: number }
  /** Hermes's delivery row for finished background sub-agents (no agent turn follows it). */
  delivery?: { delegation: string; units: number; text: string }
}

/** Fields of a background dispatch tool result, if that is what this row is. */
function dispatchOf(role: unknown, content: unknown): SessionMessage['dispatch'] {
  if (role !== 'tool' || typeof content !== 'string' || !content.startsWith('{')) return undefined
  try {
    const result = JSON.parse(content) as Record<string, unknown>
    if (result.status !== 'dispatched' || result.mode !== 'background' || typeof result.delegation_id !== 'string') return undefined
    return { delegation: result.delegation_id, count: typeof result.count === 'number' && result.count > 0 ? result.count : 1 }
  } catch { return undefined }
}

/** The sub-agent summaries from a delivery row, without Hermes's preamble or log paths. */
function deliveryOf(kind: unknown, content: unknown): SessionMessage['delivery'] {
  if (kind !== 'async_delegation_complete' || typeof content !== 'string') return undefined
  const delegation = /BATCH COMPLETE\W+(deleg_[\w-]+)/.exec(content)?.[1]
  if (!delegation) return undefined
  const units = Number(/(\d+) subagent\(s\)/.exec(content)?.[1] ?? 1)
  const sections = content.split(/^--- .*TASK \d+\/\d+:.*---$/m).slice(1)
  const text = (sections.length ? sections : [content]).map(section => section.split(/\r?\n/)
    .filter(line => !/^Full live transcript/i.test(line.trim())).join('\n').trim()).filter(Boolean).join('\n\n')
  return { delegation, units: units > 0 ? units : 1, text }
}
class HermesHttpError extends Error {
  constructor(public status: number) { super(`Hermes HTTP ${status}`) }
}
export class HermesClient {
  private session?: string
  private pendingSession?: Promise<string>
  private sessionGeneration = 0
  /** Hermes writes a keepalive every 10 s; only this much total silence counts as a dropped stream. */
  streamIdleMs = 60_000
  /** The Hermes session the most recent run went to (kept across a conversation reset). */
  lastSession?: string
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
    const created = await (await this.request('/api/sessions', { method: 'POST', body: JSON.stringify({ title: `Phantom Orbital voice/text ${randomUUID()}`, source: 'api_server' }) })).json()
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
      headers: { Authorization: `Bearer ${this.key}`, 'X-Hermes-Session-Key': 'phantom-orbital-voice', 'Content-Type': 'application/json', ...init.headers }
    })
    if (!response.ok) { await response.body?.cancel(); throw new HermesHttpError(response.status) }
    return response
  }
  async start(text: string): Promise<string> {
    // /v1/capabilities is static API discovery; skills/tools load server-side per run.
    const session = await this.prepareSession()
    this.lastSession = session
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
    // No fixed deadline: a run may think for hours. A connection is dropped only
    // after streamIdleMs of silence, and three drops in a row with no new event fail.
    for (let failures = 0; failures < 3; failures++) {
      const idle = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const touch = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new DOMException('Hermes stream idle', 'TimeoutError')), this.streamIdleMs) }
      touch()
      try {
        const response = await this.request(`/v1/runs/${encodeURIComponent(run)}/events`, {
          signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal, headers: lastId ? { 'Last-Event-ID': lastId } : {}
        })
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Invalid Hermes stream')
        // Any bytes, keepalive comments included, prove the stream is alive.
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, out) { touch(); out.enqueue(chunk) } }), { signal: idle.signal })
        for await (const event of parseSse(body)) {
          if (event.data.run_id !== run) throw new Error('Mismatched Hermes run')
          delete event.data.orb_notice // reserved for Orb's own adapters
          if (event.data.event === 'replay.truncated') throw new EventRecoveryGap('Hermes event recovery gap')
          if (typeof event.data.seq === 'number') {
            if (event.data.seq <= sequence) continue
            sequence = event.data.seq
          }
          failures = 0 // a new event: this connection was healthy
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
      } finally { clearTimeout(timer) }
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
  /** Recent messages of a session, newest page first. Only id/role/text are kept. */
  async sessionMessages(session: string): Promise<SessionMessage[]> {
    const result = await (await this.request(`/api/sessions/${encodeURIComponent(session)}/messages?order=latest&limit=50`)).json()
    if (!result || !Array.isArray(result.data)) throw new Error('Invalid Hermes messages')
    return (result.data as Record<string, unknown>[]).filter(m => m && (typeof m.id === 'string' || typeof m.id === 'number')).map(m => ({
      id: String(m.id), role: String(m.role ?? ''),
      text: typeof m.content === 'string' ? this.redact(m.content) : '',
      // A reply, not a step toward one: assistant text with no tool calls.
      reply: m.role === 'assistant' && typeof m.content === 'string' && !!m.content.trim() && !(Array.isArray(m.tool_calls) && m.tool_calls.length),
      ...(dispatchOf(m.role, m.content) ? { dispatch: dispatchOf(m.role, m.content) } : {}),
      ...(deliveryOf(m.display_kind, m.content) ? { delivery: { ...deliveryOf(m.display_kind, m.content)!, text: this.redact(deliveryOf(m.display_kind, m.content)!.text) } } : {})
    }))
  }
  private redact(text: string) { return text.split(this.key).join('[redacted]') }
}
