import { expect, test } from 'vitest'
import { ChatController } from './chat-controller'

function fixture() {
  const events: Record<string, unknown>[] = []
  let wake: (() => void) | undefined
  const sent: unknown[] = []
  const client = {
    async start() { return 'synthetic-run' },
    async *events() {
      while (true) {
        if (!events.length) await new Promise<void>(resolve => { wake = resolve })
        const data = events.shift()!
        yield { data: { run_id: 'synthetic-run', ...data } }
        if (String(data.event).startsWith('run.') && (!data.run_id || data.run_id === 'synthetic-run')) return
      }
    },
    async stop() { sent.push('stop') },
    resetSession() { sent.push('reset') },
    async approval(run: string, request: string, choice: string) { sent.push({ run, request, choice }) }
  }
  const controller = new ChatController(client, () => {})
  const emit = async (data: Record<string, unknown>) => { events.push(data); wake?.(); await new Promise(resolve => setTimeout(resolve, 0)) }
  return { controller, sent, emit }
}

test('Stop failure never re-arms replayed approvals on the same uncertain run', async () => {
  let rearmed = false, controller: ChatController
  controller = new ChatController({
    async start() { return 'synthetic-run' },
    async stop() { throw new TypeError('synthetic failed Stop') },
    async *events() {
      yield { data: { event: 'approval.request', request_id: 'first', command: 'Synthetic action' } }
      await controller.stop()
      yield { data: { event: 'approval.request', request_id: 'first', command: 'Synthetic replay' } }
      yield { data: { event: 'run.cancelled' } }
    }
  }, snapshot => { if (snapshot.approval?.action === 'Synthetic replay') rearmed = true })
  await controller.submit('synthetic')
  expect(rearmed).toBe(false)
})

test('approval remains blocked until deliberate once and exact ID is sent only once', async () => {
  const { controller, sent, emit } = fixture()
  const running = controller.submit('synthetic approval')
  await emit({ event: 'approval.request', request_id: ' exact request ', command: 'Synthetic action', choices: ['once', 'session', 'always', 'deny'] })
  expect(controller.snapshot.state).toBe('approval')
  expect(sent).toEqual([])
  const card = controller.snapshot.approval!
  expect(card.action).toBe('Synthetic action')
  expect(card).not.toHaveProperty('request_id')
  await controller.respondApproval({ id: card.id, choice: 'once' })
  await controller.respondApproval({ id: card.id, choice: 'once' })
  expect(sent).toEqual([{ run: 'synthetic-run', request: ' exact request ', choice: 'once' }])
  expect(controller.snapshot.approval?.pending).toBe(true)
  await emit({ event: 'approval.responded', request_id: ' exact request ', choice: 'once', resolved: 1 })
  expect(controller.snapshot.approval).toBeUndefined()
  await emit({ event: 'run.completed', output: 'Synthetic done' })
  await running
})

test('timeout invalidates the card and stops without a grant', async () => {
  const { controller, sent, emit } = fixture()
  const running = controller.submit('synthetic approval')
  await emit({ event: 'approval.request', request_id: 'timeout', command: 'Synthetic action' })
  const card = controller.snapshot.approval!
  // Short local policy timeout, not a fabricated backend deadline.
  controller.expireApproval(card.id)
  await controller.respondApproval({ id: card.id, choice: 'once' })
  expect(sent).toEqual(['stop'])
  expect(controller.snapshot.approval).toBeUndefined()
  await emit({ event: 'run.cancelled' }); await running
})

test('new conversation cancels a pending approval and resets only after terminal confirmation', async () => {
  const { controller, sent, emit } = fixture()
  const running = controller.submit('synthetic approval')
  await emit({ event: 'approval.request', request_id: 'cancel', command: 'Synthetic action' })
  const card = controller.snapshot.approval!
  await controller.newConversation()
  expect(controller.snapshot.busy).toBe(true)
  expect(sent).toEqual(['stop'])
  await controller.respondApproval({ id: card.id, choice: 'once' })
  await emit({ event: 'run.cancelled' }); await running
  expect(sent).toEqual(['stop', 'reset'])
  expect(controller.snapshot.busy).toBe(false)
  expect(controller.snapshot.user).toBe('')
  expect(controller.snapshot.notice).toBe('New conversation.')
})

test('foreign run events cannot settle or replace the current approval', async () => {
  const { controller, sent, emit } = fixture()
  const running = controller.submit('synthetic approval')
  await emit({ event: 'approval.request', request_id: 'current', command: 'Synthetic action' })
  await emit({ event: 'approval.responded', run_id: 'foreign', request_id: 'current', resolved: 1 })
  expect(controller.snapshot.approval).toBeDefined()
  await emit({ event: 'run.completed', run_id: 'foreign' })
  expect(controller.snapshot.busy).toBe(true)
  expect(sent).toEqual([])
  await emit({ event: 'run.cancelled' }); await running
})

test('an overlong or ambiguous action is never truncated into an approvable card', async () => {
  const { controller, sent, emit } = fixture()
  const running = controller.submit('synthetic approval')
  await emit({ event: 'approval.request', request_id: 'long', command: 'x'.repeat(2001) })
  expect(controller.snapshot.approval).toBeUndefined()
  expect(sent).toEqual(['stop'])
  await emit({ event: 'run.cancelled' }); await running
})

test('deny, invalid choices, stale IDs and extra IPC fields never widen grant scope', async () => {
  const { controller, sent, emit } = fixture()
  const running = controller.submit('synthetic approval')
  await emit({ event: 'approval.request', request_id: 'exact-deny', command: 'Synthetic action' })
  const id = controller.snapshot.approval!.id
  for (const payload of [null, {}, { id, choice: 'always' }, { id, choice: 'session' }, { id: 'foreign', choice: 'once' }, { id, choice: 'once', all: true }, { id, choice: { toString() { return 'once' } } }]) await controller.respondApproval(payload)
  expect(sent).toEqual([])
  await controller.respondApproval({ id, choice: 'deny' })
  expect(sent).toEqual([{ run: 'synthetic-run', request: 'exact-deny', choice: 'deny' }])
  await emit({ event: 'approval.responded', request_id: 'foreign', resolved: 1 })
  expect(controller.snapshot.approval?.pending).toBe(true)
  await emit({ event: 'approval.responded', request_id: 'exact-deny', choice: 'deny', resolved: 1 })
  await emit({ event: 'approval.request', request_id: 'exact-deny', command: 'Replay must not rearm' })
  expect(controller.snapshot.approval).toBeUndefined()
  await emit({ event: 'run.cancelled' }); await running
})
