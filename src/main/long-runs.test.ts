import { expect, test } from 'vitest'
import { BackgroundWatch } from './background-tasks'
import { ChatController, PROGRESS_NOTICE } from './chat-controller'
import { HermesClient, type SessionMessage } from './hermes-client'
import { VoiceController } from './voice-controller'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function slowRun(events: [number, Record<string, unknown>][]) {
  return {
    async start() { return 'run-1' },
    async *events() { for (const [delay, data] of events) { await wait(delay); yield { data: { run_id: 'run-1', ...data } } } },
    async stop() {}
  }
}

test('a quiet run says it is still working, repeats, and clears once reply text arrives', async () => {
  const notices: string[] = [], progress: string[] = []
  const chat = new ChatController(slowRun([
    [130, { event: 'message.delta', delta: 'Done. ' }],
    [10, { event: 'run.completed', output: 'Done.' }]
  ]), s => notices.push(s.notice))
  chat.progressAfterMs = 40; chat.progressEveryMs = 50
  chat.onProgress = origin => progress.push(origin)
  await chat.submit('long task', 'voice')
  expect(progress.length).toBeGreaterThanOrEqual(2) // ~40 ms, then ~90 ms
  expect(progress.every(origin => origin === 'voice')).toBe(true)
  expect(notices).toContain(PROGRESS_NOTICE)
  expect(chat.snapshot.notice).toBe('')
  const before = progress.length
  await wait(120)
  expect(progress.length).toBe(before) // no nagging after completion
})

test('a run that streams steadily never shows the progress notice', async () => {
  const progress: string[] = []
  const chat = new ChatController(slowRun([
    ...Array.from({ length: 6 }, () => [20, { event: 'message.delta', delta: 'word ' }] as [number, Record<string, unknown>]),
    [0, { event: 'run.completed', output: 'word word' }]
  ]), () => {})
  chat.progressAfterMs = 60
  chat.onProgress = origin => progress.push(origin)
  await chat.submit('hi')
  expect(progress).toEqual([])
})

test('completed runs report how many sub-agents they started', async () => {
  const completed: { output: string; delegations: number }[] = []
  const chat = new ChatController(slowRun([
    [0, { event: 'tool.started', tool: 'delegate_task' }], [0, { event: 'tool.completed', tool: 'delegate_task' }],
    [0, { event: 'tool.started', tool: 'terminal' }], [0, { event: 'tool.completed', tool: 'terminal' }],
    [0, { event: 'run.completed', output: 'I have started that in the background.' }]
  ]), () => {})
  chat.onCompleted = run => completed.push(run)
  await chat.submit('research this')
  expect(completed).toEqual([{ output: 'I have started that in the background.', delegations: 1 }])
})

test('voice progress is spoken only for an active voice request', () => {
  const sent: Record<string, unknown>[] = []
  const chat = new ChatController({ async start() { return 'r' }, async *events() {}, async stop() {} }, () => {})
  const voice = new VoiceController(chat, m => sent.push(m as Record<string, unknown>), () => {})
  voice.receive({ type: 'ready' }); voice.mode(true)
  voice.progress('voice')
  expect(sent.some(m => m.type === 'progress')).toBe(false) // no voice run in flight
  voice.chatChanged({ ...chat.snapshot, busy: true, inputOrigin: 'voice', speech: { id: 's', text: '', phase: 'stream' } })
  voice.progress('text')
  expect(sent.some(m => m.type === 'progress')).toBe(false)
  voice.progress('voice')
  expect(sent.filter(m => m.type === 'progress')).toHaveLength(1)
})

// Shapes taken from a real Hermes background run (paths made up).
const DELIVERY = '[ASYNC DELEGATION BATCH COMPLETE — deleg_ab12]\nA background fan-out unit you dispatched earlier — 1 subagent(s) — has finished; its consolidated results are below.\n\nDispatched: 2026-10-16 19:38:08 (10s ago)\n\n--- ✓ TASK 1/1: Work out the sum of 1 to 200.  (status=completed, api_calls=3, 10.72s) ---\nThe sum is 20,100.\nFull live transcript (complete tool/assistant trace): C:\Users\alex\task-0.log'
const dispatch = (id: string, delegation: string, count = 1): SessionMessage => ({ id, role: 'tool', text: '', reply: false, dispatch: { delegation, count } })
const delivery = (id: string, delegation: string, text: string, units = 1): SessionMessage => ({ id, role: 'user', text: '', reply: false, delivery: { delegation, units, text } })
const prompt = (id: string): SessionMessage => ({ id, role: 'user', text: 'do it', reply: false })
function session(initial: SessionMessage[]) {
  const messages = [...initial]
  return { messages, read: async () => [...messages] }
}

test('a background result is shown once, even when it landed before Orb started watching', async () => {
  // Fast sub-agent: the delivery row is already there when the run finishes.
  const s = session([prompt('138'), dispatch('140', 'deleg_ab12'), delivery('148', 'deleg_ab12', 'The sum is 20,100.')])
  const delivered: string[] = []
  const watch = new BackgroundWatch(s.read, text => delivered.push(text), () => false)
  await watch.completed('sess', 1)
  await watch.poll()
  expect(delivered).toEqual(['The sum is 20,100.'])
  expect(watch.watching).toBe(0)
})

test('only this run\'s dispatches are awaited; older ones and other runs are ignored', async () => {
  const s = session([prompt('10'), dispatch('11', 'deleg_old'), delivery('12', 'deleg_old', 'Old result.'), prompt('20'), dispatch('21', 'deleg_new', 2)])
  const delivered: string[] = []
  const watch = new BackgroundWatch(s.read, text => delivered.push(text), () => false)
  await watch.completed('sess', 1)
  expect(delivered).toEqual([])
  s.messages.push(delivery('25', 'deleg_new', 'First half.'))
  await watch.poll()
  expect(watch.watching).toBe(1) // two sub-agents, one reported
  s.messages.push(delivery('26', 'deleg_new', 'Second half.'))
  await watch.poll(); await watch.poll()
  expect(delivered).toEqual(['First half.', 'Second half.'])
  expect(watch.watching).toBe(0)
})

test('a run whose delegation ran in the foreground starts no watch; a silent one expires', async () => {
  const s = session([prompt('1')])
  let now = 0
  const watch = new BackgroundWatch(s.read, () => {}, () => false, 30_000, 1000, () => now)
  await watch.completed('sess', 1) // delegate_task was called, but no background dispatch row
  expect(watch.watching).toBe(0)
  s.messages.push(prompt('2'), dispatch('3', 'deleg_x'))
  await watch.completed('sess', 1)
  expect(watch.watching).toBe(1)
  now = 5000
  await watch.poll()
  expect(watch.watching).toBe(0)
})

test('session messages expose replies, background dispatches and cleaned-up deliveries', async () => {
  let url = ''
  const transport = (async (target: string) => {
    url = target
    return Response.json({ data: [
      { id: 7, role: 'assistant', content: 'Final answer with orb-mock-only inside.' },
      { id: 8, role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 't' }] },
      { id: 9, role: 'tool', content: JSON.stringify({ status: 'dispatched', mode: 'background', count: 1, delegation_id: 'deleg_ab12' }) },
      { id: 10, role: 'user', content: DELIVERY, display_kind: 'async_delegation_complete' }
    ] })
  }) as unknown as typeof fetch
  const client = new HermesClient('http://127.0.0.1:18642', 'orb-mock-only', transport, true)
  expect(await client.sessionMessages('api_1')).toEqual([
    { id: '7', role: 'assistant', text: 'Final answer with [redacted] inside.', reply: true },
    { id: '8', role: 'assistant', text: 'Let me look.', reply: false },
    { id: '9', role: 'tool', text: expect.any(String), reply: false, dispatch: { delegation: 'deleg_ab12', count: 1 } },
    { id: '10', role: 'user', text: DELIVERY, reply: false, delivery: { delegation: 'deleg_ab12', units: 1, text: 'The sum is 20,100.' } }
  ])
  expect(url).toBe('http://127.0.0.1:18642/api/sessions/api_1/messages?order=latest&limit=50')
})
