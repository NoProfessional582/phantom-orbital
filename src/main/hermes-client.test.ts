import { expect, test } from 'vitest'
// @ts-expect-error Local JS fixture server intentionally has no package dependencies.
import { startMock } from '../../scripts/mock-hermes.mjs'
import { HermesClient as LiveHermesClient } from './hermes-client'

// Existing transport scenarios are synthetic, explicitly separate from live admission.
class HermesClient extends LiveHermesClient {
  constructor(endpoint: string, key: string, transport: typeof fetch = fetch) { super(endpoint, key, transport, true) }
}

test('new app clients create distinct sessions when the old Orb title already exists', async () => {
  const mock = await startMock()
  try {
    const legacy = await fetch(mock.endpoint + '/api/sessions', {
      method: 'POST', headers: { Authorization: 'Bearer orb-mock-only', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Phantom Orbital voice/text', source: 'api_server' })
    })
    expect(legacy.status).toBe(201)
    await legacy.body?.cancel()
    const first = new HermesClient(mock.endpoint, 'orb-mock-only')
    await expect(first.start('remember blue')).resolves.toBeTruthy()
    await expect(first.start('follow up')).resolves.toBeTruthy()
    const restarted = new HermesClient(mock.endpoint, 'orb-mock-only')
    await expect(restarted.start('hello')).resolves.toBeTruthy()
    const posts = mock.requests.filter((r: any) => r.path === '/v1/runs')
    expect(posts).toHaveLength(3)
    expect(posts[0].body.session_id).toBe(posts[1].body.session_id)
    expect(posts[2].body.session_id).not.toBe(posts[0].body.session_id)
    expect(mock.sessions.size).toBe(3)
  } finally { await mock.close() }
})

test('creates and reads back one session, reuses it for context, and sends explicit fresh idempotency keys', async () => {
  const mock = await startMock()
  try {
    const client = new HermesClient(mock.endpoint, 'orb-mock-only')
    const first = await client.start('remember blue')
    const events = []; for await (const e of client.events(first)) events.push(e)
    const second = await client.start('follow up')
    const answers = []; for await (const e of client.events(second)) answers.push(e)
    expect(answers.at(-1)?.data.output).toBe('MOCK context: remember blue')
    expect(events.at(-1)?.data.event).toBe('run.completed')
    expect(mock.requests.filter((r: any) => r.path === '/api/sessions')).toHaveLength(1)
    expect(mock.requests.some((r: any) => r.path.startsWith('/api/sessions/'))).toBe(true)
    const posts = mock.requests.filter((r: any) => r.path === '/v1/runs')
    expect(posts[0].body.session_id).toBe(posts[1].body.session_id)
    expect(posts[0].headers['idempotency-key']).not.toBe(posts[1].headers['idempotency-key'])
    expect(posts[0].headers['x-hermes-session-key']).toBe('phantom-orbital-voice')
    expect(posts[0].body).not.toHaveProperty('conversation_history')
  } finally { await mock.close() }
})

test('transport retry keeps exact run body and Idempotency-Key after a lost accepted response', async () => {
  const mock = await startMock()
  let lost = false
  const transport: typeof fetch = async (url, init) => {
    const response = await fetch(url, init)
    if (String(url).endsWith('/v1/runs') && !lost) { lost = true; await response.body?.cancel(); throw new TypeError('Lost response') }
    return response
  }
  try {
    const client = new HermesClient(mock.endpoint, 'orb-mock-only', transport)
    const run = await client.start('hello')
    expect(run).toBeTruthy()
    const posts = mock.requests.filter((r: any) => r.path === '/v1/runs')
    expect(posts).toHaveLength(2)
    expect(posts[0].headers['idempotency-key']).toBe(posts[1].headers['idempotency-key'])
    expect(posts[0].body).toEqual(posts[1].body)
    expect(mock.runs.size).toBe(1)
  } finally { await mock.close() }
})

test('stop requests interruption and only terminal event confirms cancellation', async () => {
  const mock = await startMock()
  try {
    const client = new HermesClient(mock.endpoint, 'orb-mock-only')
    const run = await client.start('slow')
    const events = client.events(run)
    expect((await events.next()).value?.data.event).toBe('tool.started')
    await client.stop(run)
    expect(mock.runs.get(run).status).toBe('running')
    expect((await events.next()).value?.data.event).toBe('run.cancelled')
  } finally { await mock.close() }
})

test('resumes disconnected SSE with Last-Event-ID and deduplicates replayed sequences', async () => {
  const mock = await startMock()
  let connection = 0, resume: string | undefined
  const transport: typeof fetch = async (url, init) => {
    if (!String(url).endsWith('/events')) return fetch(url, init)
    const run = /\/runs\/([^/]+)/.exec(String(url))![1]
    connection++; resume = (init?.headers as Record<string, string>)['Last-Event-ID']
    const frame = (seq: number, event: string, fields = {}) => `id: ${seq}\ndata: ${JSON.stringify({ event, run_id: run, seq, ...fields })}\n\n`
    return new Response(frame(1, 'message.delta', { delta: 'hello' }) + (connection > 1 ? frame(2, 'run.completed', { output: 'hello' }) : ''), { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const client = new HermesClient(mock.endpoint, 'orb-mock-only', transport)
    const run = await client.start('hello'), events = []
    for await (const e of client.events(run)) events.push(e)
    expect(events).toHaveLength(2)
    expect(resume).toBe('1')
    expect(events.at(-1)?.data.event).toBe('run.completed')
  } finally { await mock.close() }
})

test('readback must confirm the exact created session before any run is submitted', async () => {
  const mock = await startMock()
  const transport: typeof fetch = async (url, init) => String(url).includes('/api/sessions/')
    ? new Response(JSON.stringify({ session: { id: 'wrong-session' } }), { status: 200 }) : fetch(url, init)
  try {
    const client = new HermesClient(mock.endpoint, 'orb-mock-only', transport)
    await expect(client.start('hello')).rejects.toThrow('Invalid Hermes session readback')
    expect(mock.runs.size).toBe(0)
  } finally { await mock.close() }
})

test('a loopback endpoint with a root trailing slash still uses canonical API paths', async () => {
  const mock = await startMock()
  try {
    const client = new HermesClient(mock.endpoint + '/', 'orb-mock-only')
    expect(await client.start('hi')).toBeTruthy()
  } finally { await mock.close() }
})

test.each(['https://127.0.0.1:8642','http://example.com','http://user:pass@127.0.0.1:8642','http://127.0.0.1:8642/?key=x'])('rejects unsafe endpoint %s before any HTTP', endpoint => {
  expect(() => new HermesClient(endpoint, 'synthetic-only')).toThrow('loopback HTTP')
})

test('authentication failure emits only a status, never backend error bodies or credentials', async () => {
  const client = new LiveHermesClient('http://127.0.0.1:8642', 'synthetic-only', async () => new Response('synthetic-only private backend error', { status: 401 }))
  await expect(client.start('hi')).rejects.toThrow(/^Hermes HTTP 401$/)
})

test('profile routing preserves Megan on every HTTP request and isolates restarted app sessions', async () => {
  const mock = await startMock({ prefix: '/p/megan', key: 'synthetic-megan' })
  try {
    const client = new HermesClient(mock.endpoint + '/p/megan/', 'synthetic-megan')
    const run = await client.start('remember blue')
    const events = []; for await (const event of client.events(run)) events.push(event)
    expect(events.at(-1)?.data.output).toBe('MOCK answer: remember blue')
    expect((await client.status(run)).status).toBe('completed')
    await client.stop(run)
    await client.start('follow up')
    await new HermesClient(mock.endpoint + '/p/megan', 'synthetic-megan').start('new conversation')
    expect(mock.requests.every((r: any) => r.path.startsWith('/p/megan/'))).toBe(true)
    expect(mock.requests.every((r: any) => r.headers.authorization === 'Bearer synthetic-megan')).toBe(true)
    const posts = mock.requests.filter((r: any) => r.path === '/p/megan/v1/runs')
    expect(posts).toHaveLength(3)
    expect(posts[1].body.session_id).toBe(posts[0].body.session_id)
    expect(posts[2].body.session_id).not.toBe(posts[0].body.session_id)
    const titles = mock.requests.filter((r: any) => r.method === 'POST' && r.path === '/p/megan/api/sessions').map((r: any) => r.body.title)
    expect(new Set(titles).size).toBe(2)
  } finally { await mock.close() }
})

test.each([401, 404, 503])('Megan HTTP %i never retries against the default route', async status => {
  const requests: string[] = []
  const client = new LiveHermesClient('http://127.0.0.1:8642/p/megan', 'synthetic-megan', async url => {
    requests.push(String(url))
    return new Response('synthetic-private-error', { status })
  })
  await expect(client.start('hello')).rejects.toThrow(`Hermes HTTP ${status}`)
  expect(requests).toEqual(['http://127.0.0.1:8642/p/megan/api/sessions'])
})

test.each(['http://127.0.0.1:8642/profiles/megan', 'http://127.0.0.1:8642/p/megan/v1', 'http://127.0.0.1:8642/p/a/b', 'http://127.0.0.1:8642/p/megan?key=x', 'http://127.0.0.1:8642/p/megan#secret'])('client rejects invalid profile base %s', endpoint => {
  expect(() => new HermesClient(endpoint, 'synthetic-only')).toThrow('loopback HTTP')
})

test('prepareSession creates the session once ahead of start and reset invalidates it', async () => {
  const paths: string[] = []
  let sessions = 0
  const client = new LiveHermesClient('http://127.0.0.1:8642/p/megan', 'synthetic-megan', async (url, init) => {
    const path = new URL(String(url)).pathname
    paths.push(`${init?.method ?? 'GET'} ${path}`)
    if (path.endsWith('/api/sessions')) return Response.json({ session: { id: `s${++sessions}` } }, { status: 201 })
    if (path.includes('/api/sessions/')) return Response.json({ session: { id: path.split('/').pop() } })
    return Response.json({ run_id: 'run', session_id: JSON.parse(String(init?.body)).session_id }, { status: 202 })
  })
  await Promise.all([client.prepareSession(), client.prepareSession()])
  await client.start('hello')
  expect(paths).toEqual(['POST /p/megan/api/sessions', 'GET /p/megan/api/sessions/s1', 'POST /p/megan/v1/runs'])
  client.resetSession()
  await expect(client.prepareSession()).resolves.toBe('s2')
})

function slowStream(parts: [number, string][]) {
  // Each part is written after its delay; the stream then stays open until aborted.
  return (async (_url: string, init?: RequestInit) => new Response(new ReadableStream({
    async start(c) {
      for (const [delay, text] of parts) {
        await new Promise(resolve => setTimeout(resolve, delay))
        if (init?.signal?.aborted) return
        c.enqueue(new TextEncoder().encode(text))
      }
    }
  }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch
}

test('a long run with only keepalives never times out', async () => {
  const keepalives: [number, string][] = Array.from({ length: 12 }, () => [25, ': keepalive\n\n'])
  const client = new HermesClient('http://127.0.0.1:18642', 'orb-mock-only', slowStream([...keepalives, [0, 'id: 1\ndata: {"event":"run.completed","run_id":"r","seq":1,"output":"done"}\n\n']]))
  client.streamIdleMs = 100 // far shorter than the 300 ms run
  const events = []; for await (const e of client.events('r')) events.push(e.data.event)
  expect(events).toEqual(['run.completed'])
})

test('a stream that goes silent fails after three idle drops', async () => {
  let connects = 0
  const silent = slowStream([[0, ': open\n\n']])
  const client = new HermesClient('http://127.0.0.1:18642', 'orb-mock-only', ((url: string, init?: RequestInit) => { connects++; return silent(url, init) }) as typeof fetch)
  client.streamIdleMs = 40
  await expect((async () => { for await (const _ of client.events('r')) { /* none */ } })()).rejects.toThrow('run status is uncertain')
  expect(connects).toBe(3)
})
