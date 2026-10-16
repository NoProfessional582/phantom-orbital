import { expect, test } from 'vitest'
// @ts-expect-error Dependency-free local synthetic contract server.
import { startMock } from '../../scripts/mock-hermes.mjs'
import { ChatController } from './chat-controller'
import { HermesClient as LiveHermesClient } from './hermes-client'
import type { ChatSnapshot } from '../shared/chat'

class HermesClient extends LiveHermesClient {
  constructor(endpoint: string, key: string, transport: typeof fetch = fetch) { super(endpoint, key, transport, true) }
}

async function card(controller: ChatController) {
  for (let attempt = 0; attempt < 100 && !controller.snapshot.approval; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(controller.snapshot.approval).toBeDefined()
  return controller.snapshot.approval!
}

test('approval action is redacted before any minimal renderer display', async () => {
  const mock = await startMock()
  const changes: ChatSnapshot[] = []
  const controller = new ChatController(new HermesClient(mock.endpoint, 'orb-mock-only'), s => changes.push(s))
  try {
    const running = controller.submit('approval-echo-secret')
    expect((await card(controller)).action).toContain('[redacted]')
    expect(JSON.stringify(changes)).not.toContain('orb-mock-only')
    await controller.stop(); await running
  } finally { await mock.close() }
})

test('Megan-scoped reconnect replays approval without duplicate grants and new conversation isolates session', async () => {
  const mock = await startMock({ prefix: '/p/megan', key: 'synthetic-megan' })
  try {
    const controller = new ChatController(new HermesClient(mock.endpoint + '/p/megan', 'synthetic-megan'), () => {})
    const running = controller.submit('approval-reconnect')
    const first = await card(controller)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(controller.snapshot.approval?.id).toBe(first.id)
    await controller.respondApproval({ id: first.id, choice: 'once' })
    await controller.respondApproval({ id: first.id, choice: 'once' })
    await running
    const approvals = mock.requests.filter((r: any) => r.path.endsWith('/approval'))
    expect(approvals).toHaveLength(1)
    expect(approvals[0].body).toEqual({ choice: 'once', request_id: `mock-approval-${approvals[0].path.split('/')[5]}` })
    expect([...mock.runs.values()][0].connections).toBe(2)
    await controller.newConversation()
    await controller.submit('follow up')
    expect(controller.snapshot.answer).toBe('MOCK context: none')
    const posts = mock.requests.filter((r: any) => r.path.endsWith('/v1/runs'))
    expect(posts[0].body.session_id).not.toBe(posts[1].body.session_id)
    expect(mock.requests.every((r: any) => r.path.startsWith('/p/megan/'))).toBe(true)
  } finally { await mock.close() }
})

test('synthetic backend timeout clears card and rejects stale once intent', async () => {
  const mock = await startMock()
  try {
    const controller = new ChatController(new HermesClient(mock.endpoint, 'orb-mock-only'), () => {})
    const running = controller.submit('approval-timeout')
    const id = (await card(controller)).id
    await running
    await controller.respondApproval({ id, choice: 'once' })
    expect(controller.snapshot.approval).toBeUndefined()
    expect(controller.snapshot.state).toBe('offline')
    expect(mock.requests.filter((r: any) => r.path.endsWith('/approval'))).toHaveLength(0)
  } finally { await mock.close() }
})

test('lost approval response is not retried, even when the backend accepted once', async () => {
  const mock = await startMock()
  const transport: typeof fetch = async (url, init) => {
    const response = await fetch(url, init)
    if (String(url).endsWith('/approval')) { await response.body?.cancel(); throw new TypeError('synthetic lost receipt') }
    return response
  }
  try {
    const controller = new ChatController(new HermesClient(mock.endpoint, 'orb-mock-only', transport), () => {})
    const running = controller.submit('approval')
    const id = (await card(controller)).id
    await controller.respondApproval({ id, choice: 'once' })
    expect(controller.snapshot.notice).toContain('uncertain')
    await controller.respondApproval({ id, choice: 'once' })
    await running
    expect(mock.requests.filter((r: any) => r.path.endsWith('/approval'))).toHaveLength(1)
  } finally { await mock.close() }
})
