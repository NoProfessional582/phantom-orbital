import { expect, test } from 'vitest'
import { ChatController } from './chat-controller'

test('Stop confirms by status even if a connected stream never sends its terminal event', async () => {
  let reset = 0, active = true
  const controller = new ChatController({
    async start() { return 'synthetic-run' },
    async *events(_run: string, signal?: AbortSignal) {
      await new Promise<void>(resolve => { signal?.addEventListener('abort', () => resolve(), { once: true }) })
      if (active) yield { data: { event: 'message.delta', delta: 'stale' } }
    },
    async stop() { active = false },
    async status() { return { run_id: 'synthetic-run', status: 'cancelled' } },
    resetSession() { reset++ }
  }, () => {})
  const running = controller.submit('mock only')
  await new Promise(resolve => setTimeout(resolve, 0))
  await controller.newConversation()
  expect(controller.snapshot.busy).toBe(false)
  expect(controller.snapshot.answer).toBe('')
  expect(reset).toBe(1)
  await running
})

test('read-only recovery unlocks only an exact terminal run status after disconnect', async () => {
  let status = 'running', resets = 0
  const controller = new ChatController({
    async start() { return 'synthetic-run' },
    async *events() { throw new TypeError('synthetic disconnect') },
    async stop() {},
    async status() { return { run_id: 'synthetic-run', status, output: 'Synthetic recovered answer' } },
    resetSession() { resets++ }
  }, () => {})
  await controller.submit('synthetic')
  await controller.recover()
  expect(controller.snapshot.busy).toBe(true)
  expect(resets).toBe(0)
  status = 'completed'
  await controller.recover()
  expect(controller.snapshot.busy).toBe(false)
  expect(controller.snapshot.answer).toBe('Synthetic recovered answer')
})
