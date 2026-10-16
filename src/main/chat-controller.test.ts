import { expect, test } from 'vitest'
// @ts-expect-error Local synthetic fixtures.
import { startMock } from '../../scripts/mock-hermes.mjs'
import { HermesClient as LiveHermesClient } from './hermes-client'
import { ChatController } from './chat-controller'
import type { ChatSnapshot } from '../shared/chat'

class HermesClient extends LiveHermesClient {
  constructor(endpoint: string, key: string, transport: typeof fetch = fetch) { super(endpoint, key, transport, true) }
}

test('thinking while waiting, working for tools, caption deltas and one authoritative final answer', async () => {
  const mock = await startMock()
  try {
    const changes: ChatSnapshot[] = []
    const controller = new ChatController(new HermesClient(mock.endpoint, 'orb-mock-only'), s => changes.push(s))
    const pending = controller.submit('hi')
    expect(controller.snapshot.state).toBe('thinking')
    await pending
    expect(changes.some(s => s.state === 'working')).toBe(true)
    expect(changes.some(s => s.answer === 'MOCK ans')).toBe(true)
    expect(controller.snapshot.answer).toBe('MOCK answer: hi')
    expect(controller.snapshot.busy).toBe(false)
    expect(controller.snapshot.state).toBe('idle')
  } finally { await mock.close() }
})

test('Stop during run creation is retained and blocks overlapping submissions until cancelled', async () => {
  const mock = await startMock({ delay: 50 })
  try {
    const controller = new ChatController(new HermesClient(mock.endpoint, 'orb-mock-only'), () => {})
    const pending = controller.submit('slow')
    await controller.stop()
    expect(controller.snapshot.stopping).toBe(true)
    await controller.submit('must not send')
    await pending
    expect(controller.snapshot.busy).toBe(false)
    expect(controller.snapshot.notice).toBe('Stopped.')
    expect(mock.requests.filter((r: any) => r.path === '/v1/runs')).toHaveLength(1)
    expect(mock.requests.some((r: any) => r.path.endsWith('/stop'))).toBe(true)
  } finally { await mock.close() }
})

test('mock approval gates execution until deliberate deny with exact request ID', async () => {
  const mock = await startMock()
  try {
    const changes: ChatSnapshot[] = []
    const controller = new ChatController(new HermesClient(mock.endpoint, 'orb-mock-only'), s => changes.push(s))
    const running = controller.submit('approval')
    for (let attempt = 0; attempt < 100 && !controller.snapshot.approval; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(changes.some(s => s.notice.includes('Approval required'))).toBe(true)
    expect(mock.requests.some((r: any) => r.path.endsWith('/approval'))).toBe(false)
    const id = controller.snapshot.approval!.id
    await controller.respondApproval({ id, choice: 'deny' })
    await running
    const decisions = mock.requests.filter((r: any) => r.path.endsWith('/approval'))
    expect(decisions).toHaveLength(1)
    expect(decisions[0].body).toEqual({ choice: 'deny', request_id: `mock-approval-${decisions[0].path.split('/')[3]}` })
    expect(controller.snapshot.busy).toBe(false)
  } finally { await mock.close() }
})

test('failed terminal event releases busy state with an accurate error notice', async () => {
  const mock = await startMock()
  try {
    const controller = new ChatController(new HermesClient(mock.endpoint, 'orb-mock-only'), () => {})
    await controller.submit('fail')
    expect(controller.snapshot.busy).toBe(false)
    expect(controller.snapshot.state).toBe('offline')
    expect(controller.snapshot.notice).toBe('Run failed.')
  } finally { await mock.close() }
})

test('disconnection retains busy state and rejects follow-ups because server may still work', async () => {
  const mock = await startMock()
  try {
    const controller = new ChatController(new HermesClient(mock.endpoint, 'orb-mock-only'), () => {})
    await controller.submit('disconnect')
    expect(controller.snapshot.busy).toBe(true)
    expect(controller.snapshot.state).toBe('offline')
    expect(controller.snapshot.notice).toContain('uncertain')
    await controller.submit('do not send')
    expect(mock.runs.size).toBe(1)
  } finally { await mock.close() }
})

test.each([null, {}, '', '   ', 'a'.repeat(8001)])('invalid IPC text never reaches Hermes: %s', async text => {
  let called = false
  const client = { async start() { called = true; return '' }, async *events() {}, async stop() {} }
  const controller = new ChatController(client, () => {})
  await controller.submit(text)
  expect(called).toBe(false)
})

test('lost start responses never admit a second logical run with a fresh key', async () => {
  const mock = await startMock()
  const transport: typeof fetch = async (url, init) => {
    const response = await fetch(url, init)
    if (String(url).endsWith('/v1/runs')) { await response.body?.cancel(); throw new TypeError('lost') }
    return response
  }
  try {
    const controller = new ChatController(new HermesClient(mock.endpoint, 'orb-mock-only', transport), () => {})
    await controller.submit('hello')
    expect(controller.snapshot.busy).toBe(true)
    expect(controller.snapshot.notice).toContain('uncertain')
    await controller.submit('duplicate')
    expect(mock.runs.size).toBe(1)
  } finally { await mock.close() }
})

test('Stop after disconnection confirms terminal status by HTTP readback before unlocking', async () => {
  const mock = await startMock()
  try {
    const controller = new ChatController(new HermesClient(mock.endpoint, 'orb-mock-only'), () => {})
    await controller.submit('disconnect')
    expect(controller.snapshot.busy).toBe(true)
    await controller.stop()
    expect(controller.snapshot.busy).toBe(false)
    expect(controller.snapshot.notice).toBe('Stopped.')
    expect(mock.requests.some((r: any) => /^\/v1\/runs\/[^/]+$/.test(r.path) && r.method === 'GET')).toBe(true)
  } finally { await mock.close() }
})

test('even a backend echo split across chunks never exposes the credential through renderer snapshots', async () => {
  const mock = await startMock()
  try {
    const changes: ChatSnapshot[] = []
    const controller = new ChatController(new HermesClient(mock.endpoint, 'orb-mock-only'), s => changes.push(s))
    await controller.submit('echo-secret')
    expect(JSON.stringify(changes)).not.toContain('orb-mock-only')
    expect(controller.snapshot.answer).toBe('MOCK secret: [redacted]')
    expect(changes.some(s => s.answer.endsWith('orb-m'))).toBe(false)
  } finally { await mock.close() }
})

test('parallel tool/subagent activity stays working until the last completion', async () => {
  const changes: ChatSnapshot[] = []
  const client = { async start() { return 'run' }, async stop() {}, async *events() {
    for (const event of ['tool.started','subagent.start','tool.completed','subagent.complete','run.completed']) yield { data: { event } }
  } }
  const controller = new ChatController(client, s => changes.push(s))
  await controller.submit('hello')
  expect(changes.map(s => s.state)).toEqual(['thinking','working','working','working','thinking','idle'])
})

test('replay truncation is a visible recovery gap, never permission to continue', async () => {
  const mock = await startMock()
  const transport: typeof fetch = async (url, init) => {
    if (!String(url).endsWith('/events')) return fetch(url, init)
    const run_id = /\/runs\/([^/]+)/.exec(String(url))![1]
    return new Response(`data: ${JSON.stringify({ event: 'replay.truncated', run_id, seq: 9 })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const controller = new ChatController(new HermesClient(mock.endpoint, 'orb-mock-only', transport), () => {})
    await controller.submit('hi')
    expect(controller.snapshot.notice).toContain('recovery gap')
    expect(controller.snapshot.busy).toBe(true)
  } finally { await mock.close() }
})

test('server errors after accepting work retry the same key, then remain uncertain', async () => {
  const mock = await startMock()
  const transport: typeof fetch = async (url, init) => {
    const response = await fetch(url, init)
    if (String(url).endsWith('/v1/runs')) { await response.body?.cancel(); return new Response('private error', { status: 500 }) }
    return response
  }
  try {
    const controller = new ChatController(new HermesClient(mock.endpoint, 'orb-mock-only', transport), () => {})
    await controller.submit('hi')
    expect(controller.snapshot.busy).toBe(true)
    expect(controller.snapshot.notice).toContain('uncertain')
    const posts = mock.requests.filter((r: any) => r.path === '/v1/runs')
    expect(posts).toHaveLength(2)
    expect(posts[0].headers['idempotency-key']).toBe(posts[1].headers['idempotency-key'])
    expect(mock.runs.size).toBe(1)
  } finally { await mock.close() }
})

test.each(['null', '{}', '{'])('unusable accepted run response %s preserves uncertainty', async body => {
  const mock = await startMock()
  const transport: typeof fetch = async (url, init) => {
    const response = await fetch(url, init)
    if (String(url).endsWith('/v1/runs')) { await response.body?.cancel(); return new Response(body, { status: 202 }) }
    return response
  }
  try {
    const controller = new ChatController(new HermesClient(mock.endpoint, 'orb-mock-only', transport), () => {})
    await controller.submit('hi')
    expect(controller.snapshot.busy).toBe(true)
    expect(controller.snapshot.notice).toContain('uncertain')
  } finally { await mock.close() }
})
