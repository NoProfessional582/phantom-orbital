import { afterEach, expect, test, vi } from 'vitest'
import { ChatController } from './chat-controller'
import { VoiceController } from './voice-controller'

afterEach(() => vi.useRealTimers())

function fixture() {
  vi.useFakeTimers()
  const sent: Record<string, unknown>[] = [], sessions: number[] = []
  let session = 1, finish!: () => void, voice: VoiceController
  const chat = new ChatController({
    async start() { sessions.push(session); return `run-${sessions.length}` },
    async *events() { await new Promise<void>(resolve => { finish = resolve }); yield { data: { event: 'run.completed', output: 'A complete reply.' } } },
    async stop() {}, resetSession() { session++ }
  }, snapshot => voice.chatChanged(snapshot))
  voice = new VoiceController(chat, m => sent.push(m as Record<string, unknown>), () => {})
  voice.receive({ type: 'ready' }); voice.mode(true)
  voice.receive({ type: 'speaker', registered: true, enrolling: false, count: 0, message: '' })
  async function voiceTurn(followup?: string) {
    voice.receive(followup ? { type: 'state', state: 'followup', followup } : { type: 'state', state: 'listening' })
    voice.receive({ type: 'transcript', text: 'A synthetic question', ...(followup ? { followup } : {}) })
    await vi.advanceTimersByTimeAsync(0)
  }
  async function complete() { finish(); await vi.advanceTimersByTimeAsync(0) }
  function playback() {
    const stream = chat.snapshot.speech!.id
    voice.receive({ type: 'speech-ack', stream, seq: 0 })
    voice.receive({ type: 'speech-done', stream, played: true })
    return stream
  }
  return { voice, chat, sent, sessions, voiceTurn, complete, playback }
}

test('PTT opens direct follow-up only after final credited playback; timeout resets once', async () => {
  const f = fixture()
  await f.voiceTurn(); await f.complete()
  const id = f.chat.snapshot.speech!.id
  f.voice.receive({ type: 'speech-done', stream: id })
  await vi.advanceTimersByTimeAsync(6000)
  expect(f.sent.some(x => x.type === 'followup')).toBe(false)
  f.playback()
  expect(f.sent).toContainEqual({ type: 'followup', id })
  f.voice.receive({ type: 'followup-ended', id })
  expect(f.chat.snapshot.answer).toBe('')
  expect(f.chat.snapshot.notice).toBe('')
  expect(f.sent).toContainEqual({ type: 'followup-reset', id })
  expect(f.voice.snapshot.activation).toBe(false)
  f.voice.receive({ type: 'followup-ended', id })
  await f.voiceTurn()
  expect(f.sessions).toEqual([1, 2])
})

test('accepted direct follow-up shares backend context; stale ended cannot reset newer run', async () => {
  const f = fixture()
  await f.voiceTurn(); await f.complete(); const id = f.playback()
  await f.voiceTurn(id)
  expect(f.sessions).toEqual([1, 1])
  f.voice.receive({ type: 'followup-ended', id })
  await vi.advanceTimersByTimeAsync(30000)
  expect(f.chat.snapshot.busy).toBe(true)
  await f.complete(); const next = f.playback()
  expect(next).not.toBe(id)
  expect(f.sent).toContainEqual({ type: 'followup', id: next })
})

test.each(['stop', 'mute', 'off', 'disconnect', 'ready', 'error'] as const)('%s rejects late follow-up events and never restores capture', async action => {
  const f = fixture()
  await f.voiceTurn(); await f.complete(); const id = f.playback()
  if (action === 'off') f.voice.mode(false)
  else if (action === 'disconnect') f.voice.disconnected()
  else if (action === 'ready' || action === 'error') f.voice.receive({ type: action })
  else f.voice[action]()
  await f.voiceTurn(id)
  f.voice.receive({ type: 'followup-ended', id })
  expect(f.sessions).toEqual([1])
  expect(f.voice.snapshot.activation).toBe(false)
})

test('text inactivity starts at successful completion, expires at 60s and starts new context', async () => {
  const f = fixture()
  void f.chat.submit('typed')
  await vi.advanceTimersByTimeAsync(120000)
  expect(f.chat.snapshot.busy).toBe(true)
  await f.complete()
  await vi.advanceTimersByTimeAsync(59999)
  expect(f.chat.snapshot.answer).toBe('A complete reply.')
  await vi.advanceTimersByTimeAsync(1)
  expect(f.chat.snapshot.answer).toBe('')
  void f.chat.submit('next typed')
  await vi.advanceTimersByTimeAsync(0)
  expect(f.sessions).toEqual([1, 2])
  expect(f.sent.some(x => x.type === 'speech-begin' || x.type === 'followup')).toBe(false)
})

test('active text draft owns conversation, pauses expiry and clearing draft restarts full 60s', async () => {
  const f = fixture()
  void f.chat.submit('typed'); await vi.advanceTimersByTimeAsync(0); await f.complete()
  await vi.advanceTimersByTimeAsync(59000)
  f.voice.textActivity(true)
  await vi.advanceTimersByTimeAsync(120000)
  expect(f.chat.snapshot.answer).toBe('A complete reply.')
  f.voice.textActivity(false)
  await vi.advanceTimersByTimeAsync(59999)
  expect(f.chat.snapshot.answer).not.toBe('')
  await vi.advanceTimersByTimeAsync(1)
  expect(f.chat.snapshot.answer).toBe('')
})

test('typing takes follow-up ownership without erasing draft or accepting stale capture', async () => {
  const f = fixture()
  await f.voiceTurn(); await f.complete(); const id = f.playback()
  f.voice.textActivity(true)
  f.voice.receive({ type: 'followup-ended', id })
  await f.voiceTurn(id)
  await vi.advanceTimersByTimeAsync(120000)
  expect(f.sessions).toEqual([1])
  expect(f.chat.snapshot.answer).not.toBe('')
  f.voice.textActivity(false)
  await vi.advanceTimersByTimeAsync(60000)
  expect(f.chat.snapshot.answer).toBe('')
})

test('PTT ownership pauses old text timer; new voice reply gets five second direct window', async () => {
  const f = fixture()
  void f.chat.submit('typed'); await vi.advanceTimersByTimeAsync(0); await f.complete()
  await vi.advanceTimersByTimeAsync(59000)
  f.voice.hold(true)
  await vi.advanceTimersByTimeAsync(60000)
  expect(f.chat.snapshot.answer).not.toBe('')
  await f.voiceTurn(); await f.complete(); const id = f.playback()
  expect(f.sessions).toEqual([1, 1])
  expect(f.sent).toContainEqual({ type: 'followup', id })
})

test.each(['mute', 'off', 'error'] as const)('voice %s uses conservative silent five-second expiry, never unmute capture', async action => {
  const f = fixture()
  await f.voiceTurn()
  if (action === 'off') f.voice.mode(false)
  else if (action === 'mute') f.voice.mute()
  else f.voice.receive({ type: 'error' })
  await f.complete()
  if (action === 'mute') f.voice.mute()
  await vi.advanceTimersByTimeAsync(4999)
  expect(f.chat.snapshot.answer).not.toBe('')
  await vi.advanceTimersByTimeAsync(1)
  expect(f.chat.snapshot.answer).toBe('')
  expect(f.sent.some(x => x.type === 'followup')).toBe(false)
})

test('new conversation and newer run invalidate old text deadline', async () => {
  const f = fixture()
  void f.chat.submit('typed'); await vi.advanceTimersByTimeAsync(0); await f.complete()
  await vi.advanceTimersByTimeAsync(59000)
  await f.chat.newConversation()
  void f.chat.submit('newer'); await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(5000)
  expect(f.chat.snapshot.busy).toBe(true)
  await f.complete()
  await vi.advanceTimersByTimeAsync(59999)
  expect(f.chat.snapshot.answer).not.toBe('')
  expect(f.sessions).toEqual([1, 2])
})

test('native hotkey listening takes ownership before a queued old follow-up expiry', async () => {
  const f = fixture()
  await f.voiceTurn(); await f.complete(); const id = f.playback()
  f.voice.receive({ type: 'state', state: 'listening' })
  f.voice.receive({ type: 'followup-ended', id })
  expect(f.chat.snapshot.answer).not.toBe('')
  f.voice.receive({ type: 'state', state: 'idle', followup: id })
  expect(f.voice.snapshot.state).toBe('listening')
})

test('unexpected ready during generation disarms speech and future capture', async () => {
  const f = fixture()
  await f.voiceTurn()
  f.voice.receive({ type: 'ready' })
  await f.complete()
  f.playback()
  expect(f.sent.some(x => x.type === 'followup')).toBe(false)
  expect(f.voice.snapshot.enabled).toBe(false)
})

test('empty silent reply never authorizes capture and expires conservatively', async () => {
  const f = fixture()
  f.voice.activation(true)
  await f.voiceTurn()
  const speech = { ...f.chat.snapshot.speech!, text: '', phase: 'complete' as const }
  f.chat.snapshot = { ...f.chat.snapshot, speech, busy: false }
  f.voice.chatChanged(f.chat.snapshot)
  f.voice.receive({ type: 'speech-done', stream: speech.id })
  expect(f.sent.some(x => x.type === 'followup')).toBe(false)
  expect(f.voice.snapshot.activation).toBe(false)
  await vi.advanceTimersByTimeAsync(5000)
  expect(f.chat.snapshot.speech).toBeUndefined()
})

test.each(['capturing', 'verifying'] as const)('PTT can take direct %s ownership but stale follow-up cannot submit', async state => {
  const f = fixture()
  await f.voiceTurn(); await f.complete(); const id = f.playback()
  f.voice.receive({ type: 'state', state, followup: id })
  expect(f.voice.snapshot.followupActive).toBe(true)
  f.voice.hold(true)
  expect(f.sent.at(-1)).toEqual({ type: 'start' })
  expect(f.voice.snapshot.followupActive).toBe(false)
  await f.voiceTurn(id)
  expect(f.sessions).toEqual([1])
})

test('credited but zero-sample synthesis never reopens direct or wake listening', async () => {
  const f = fixture()
  f.voice.activation(true)
  await f.voiceTurn(); await f.complete()
  const stream = f.chat.snapshot.speech!.id
  f.voice.receive({ type: 'speech-ack', stream, seq: 0 })
  f.voice.receive({ type: 'speech-done', stream, played: false })
  expect(f.sent.some(x => x.type === 'followup')).toBe(false)
  expect(f.voice.snapshot.activation).toBe(false)
})
