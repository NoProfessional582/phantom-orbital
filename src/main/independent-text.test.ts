import { afterEach, expect, test, vi } from 'vitest'
import { ChatController } from './chat-controller'
import { VoiceController } from './voice-controller'
import type { VoiceMode } from '../shared/voice'

afterEach(() => vi.useRealTimers())
function fixture(mode: VoiceMode, pending = false) {
  vi.useFakeTimers()
  const sent: Record<string, unknown>[] = [], sessions: number[] = []
  let finish!: () => void, session = 1, voice: VoiceController
  const chat = new ChatController({
    async start() { sessions.push(session); return `run-${sessions.length}` },
    async *events() { yield { data: { event: 'message.delta', delta: 'Text must stay silent. ' } }; await new Promise<void>(r => { finish = r }); yield { data: { event: 'run.completed', output: 'Text must stay silent.' } } },
    async stop() {}, resetSession() { session++ }
  }, s => voice.chatChanged(s))
  voice = new VoiceController(chat, m => sent.push(m as Record<string, unknown>), () => {})
  voice.receive({ type: 'ready' })
  voice.receive({ type: 'speaker', registered: true, enrolling: false, count: 0, message: '' })
  voice.setMode(mode)
  const revision = [...sent].reverse().find(m => m.type === 'voice-mode')!.revision
  if (!pending) {
    voice.receive({ type: 'mode-ready', mode, revision })
    voice.receive({ type: 'state', state: mode === 'active' ? 'armed' : 'idle', revision })
  }
  sent.length = 0
  return { chat, voice, sent, sessions, revision, complete: async () => { finish(); await vi.advanceTimersByTimeAsync(0) } }
}

test.each(['off', 'voice', 'active'] as const)('composer and typing preserve %s selection and passive listener without mode commands', mode => {
  const f = fixture(mode), before = { ...f.voice.snapshot }
  f.chat.toggleInput(); expect(f.chat.snapshot.inputOpen).toBe(true)
  f.chat.toggleInput(); expect(f.chat.snapshot.inputOpen).toBe(false)
  f.voice.textActivity(true); f.voice.textActivity(false)
  expect(f.voice.snapshot).toEqual(before)
  expect(f.sent).toEqual([])
})

test('typing preserves pending wake intent and accepts its original listener acknowledgement', () => {
  const f = fixture('active', true)
  f.voice.textActivity(true)
  expect(f.voice.snapshot.pendingMode).toBe('active')
  expect(f.sent).toEqual([])
  f.voice.receive({ type: 'mode-ready', mode: 'active', revision: f.revision })
  expect(f.voice.snapshot.mode).toBe('active')
  expect(f.voice.snapshot.activation).toBe(true)
})

test.each(['off', 'voice', 'active'] as const)('typed completion unpauses %s without a new mode command or direct capture', async mode => {
  const f = fixture(mode)
  f.voice.textActivity(false)
  void f.chat.submit('typed without touching voice')
  await vi.advanceTimersByTimeAsync(0)
  await f.complete()
  expect(f.sent).toEqual([{ type: 'pause', paused: true }, { type: 'pause', paused: false }])
  expect(f.voice.snapshot.mode).toBe(mode)
  expect(f.voice.snapshot.activation).toBe(mode === 'active')
})

test('typed run preserves a pending wake selection until its listener becomes ready after completion', async () => {
  const f = fixture('active', true)
  f.voice.textActivity(false)
  void f.chat.submit('typed while wake is preparing')
  await vi.advanceTimersByTimeAsync(0)
  await f.complete()
  expect(f.voice.snapshot.pendingMode).toBe('active')
  f.voice.receive({ type: 'mode-ready', mode: 'active', revision: f.revision })
  f.voice.receive({ type: 'state', state: 'armed', revision: f.revision })
  expect(f.voice.snapshot.mode).toBe('active')
  expect(f.sent).toEqual([{ type: 'pause', paused: true }, { type: 'pause', paused: false }])
})

test('typing interrupts a real wake capture without changing selection and rejects its old revision', async () => {
  const f = fixture('active')
  f.voice.receive({ type: 'state', state: 'capturing', revision: f.revision })
  f.voice.textActivity(true)
  expect(f.voice.snapshot.mode).toBe('active')
  expect(f.voice.snapshot.activation).toBe(true)
  const command = f.sent.find(m => m.type === 'voice-mode')!
  expect(command.mode).toBe('active')
  f.voice.receive({ type: 'transcript', text: 'stale voice', revision: f.revision })
  expect(f.sessions).toEqual([])
  f.voice.receive({ type: 'mode-ready', mode: 'active', revision: command.revision })
  f.voice.textActivity(false)
  void f.chat.submit('typed replacement')
  await vi.advanceTimersByTimeAsync(0)
  await f.complete()
  expect(f.sent.some(m => ['speech-begin', 'speech-append', 'followup', 'start'].includes(String(m.type)))).toBe(false)
  expect(f.voice.snapshot.mode).toBe('active')
})

test.each(['off', 'voice', 'active'] as const)('typed generation in %s remains silent across mode changes and resumes only selected wake intent', async mode => {
  const f = fixture(mode)
  f.voice.textActivity(false)
  void f.chat.submit('typed')
  await vi.advanceTimersByTimeAsync(0)
  const id = f.chat.snapshot.speech!.id
  expect(f.chat.snapshot.inputOrigin).toBe('text')
  f.voice.setMode('off')
  f.voice.setMode('active')
  f.voice.setMode(mode)
  const revision = [...f.sent].reverse().find(m => m.type === 'voice-mode')!.revision
  f.voice.receive({ type: 'mode-ready', mode, revision })
  await f.complete()
  f.voice.receive({ type: 'speech-done', stream: id, played: true })
  expect(f.chat.snapshot.inputOrigin).toBe('text')
  expect(f.sent.filter(m => ['speech-begin', 'speech-append', 'speak', 'start', 'followup'].includes(String(m.type)))).toEqual([])
  expect(f.sent.filter(m => m.type === 'pause')).toEqual([{ type: 'pause', paused: true }, { type: 'pause', paused: false }])
  expect(f.voice.snapshot.mode).toBe(mode)
  expect(f.voice.snapshot.activation).toBe(mode === 'active')
  await vi.advanceTimersByTimeAsync(59999)
  expect(f.chat.snapshot.answer).toBe('Text must stay silent.')
  await vi.advanceTimersByTimeAsync(1)
  expect(f.chat.snapshot.answer).toBe('')
  expect(f.voice.snapshot.mode).toBe(mode)
  void f.chat.submit('same selected mode, new session')
  await vi.advanceTimersByTimeAsync(0)
  expect(f.sessions).toEqual([1, 2])
})
