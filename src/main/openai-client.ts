import { randomUUID } from 'node:crypto'
import { RunStartUncertain } from './hermes-client'
import type { SseEvent } from './sse'

// Generic adapter for any OpenAI-compatible /chat/completions server (OpenClaw's
// gateway, Ollama, LM Studio, vLLM, hosted APIs...). It emits the same run events
// ChatController reads from Hermes. There are no tool approvals: whatever tools the
// server runs, it runs on its own policy. Conversation history lives here in memory.

type Message = { role: 'system' | 'user' | 'assistant'; content: string }
type Run = { text: string; abort: AbortController; status: 'running' | 'completed' | 'cancelled' | 'failed'; output: string }
const MAX_HISTORY = 40

export function validOpenAiEndpoint(endpoint: string): URL {
  let url: URL
  try { url = new URL(endpoint) } catch { throw new Error('OpenAI-compatible endpoint is not a URL') }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash) throw new Error('Endpoint must not contain credentials, a query or a fragment')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Use https, or plain http only on this PC (127.0.0.1/localhost)')
  return url
}

export class OpenAiClient {
  private history: Message[] = []
  private runs = new Map<string, Run>()
  private endpoint: string
  constructor(endpoint: string, private model: string, private key = '', private system = '', private transport: typeof fetch = fetch) {
    this.endpoint = validOpenAiEndpoint(endpoint).href.replace(/\/$/, '')
    if (/[\r\n]/.test(key)) throw new Error('Invalid API key')
  }
  resetSession() { this.history = [] }
  prepareSession() { return Promise.resolve('local') }
  async start(text: string): Promise<string> {
    const id = randomUUID()
    this.runs.set(id, { text, abort: new AbortController(), status: 'running', output: '' })
    return id
  }
  async *events(id: string, signal?: AbortSignal): AsyncGenerator<SseEvent> {
    const run = this.runs.get(id)
    if (!run) throw new Error('Unknown run')
    const messages: Message[] = [...(this.system ? [{ role: 'system' as const, content: this.system }] : []), ...this.history, { role: 'user', content: run.text }]
    const abort = signal ? AbortSignal.any([signal, run.abort.signal]) : run.abort.signal
    let response: Response
    try {
      response = await this.transport(this.endpoint + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([abort, AbortSignal.timeout(300_000)]),
        headers: { 'Content-Type': 'application/json', ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}) },
        body: JSON.stringify({ model: this.model, messages, stream: true })
      })
    } catch (error) {
      if (run.abort.signal.aborted) { run.status = 'cancelled'; yield { data: { event: 'run.cancelled', run_id: id } }; return }
      if (signal?.aborted) throw error
      throw new RunStartUncertain('Chat server unreachable')
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      run.status = 'failed'
      yield { data: { event: 'run.failed', run_id: id, error: `HTTP ${response.status}` } }
      return
    }
    try {
      for await (const delta of chatDeltas(response.body)) {
        const clean = this.redact(delta)
        run.output += clean
        yield { data: { event: 'message.delta', run_id: id, delta: clean } }
      }
    } catch (error) {
      if (run.abort.signal.aborted) { run.status = 'cancelled'; yield { data: { event: 'run.cancelled', run_id: id } }; return }
      if (signal?.aborted) throw error
      run.status = 'failed'
      yield { data: { event: 'run.failed', run_id: id } }
      return
    }
    run.status = 'completed'
    this.history.push({ role: 'user', content: run.text }, { role: 'assistant', content: run.output })
    this.history = this.history.slice(-MAX_HISTORY)
    yield { data: { event: 'run.completed', run_id: id, output: run.output } }
  }
  async stop(id: string): Promise<void> {
    const run = this.runs.get(id)
    if (!run) return
    if (run.status === 'running') run.status = 'cancelled'
    run.abort.abort()
  }
  async status(id: string): Promise<Record<string, unknown>> {
    const run = this.runs.get(id)
    return { run_id: id, status: run?.status ?? 'failed', output: run?.output ?? '' }
  }
  private redact(text: string) { return this.key ? text.split(this.key).join('[redacted]') : text }
}

/** Text deltas from an OpenAI-style SSE stream (`data: {...}` lines ending with `data: [DONE]`). */
export async function* chatDeltas(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader(), decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const part = await reader.read()
      buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true })
      if (buffer.length > 2_000_000) throw new Error('Event too large')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0 || (part.done && buffer)) {
        const line = (newline >= 0 ? buffer.slice(0, newline) : buffer).replace(/\r$/, '')
        buffer = newline >= 0 ? buffer.slice(newline + 1) : ''
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        const parsed = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[]; error?: unknown }
        if (parsed.error) throw new Error('Chat server error')
        const content = parsed.choices?.[0]?.delta?.content
        if (typeof content === 'string' && content) yield content
      }
      if (part.done) return
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
