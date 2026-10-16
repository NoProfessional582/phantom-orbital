import { afterEach, expect, test, vi } from 'vitest'
import { ChatController } from './chat-controller'
import { VoiceController } from './voice-controller'

afterEach(() => { vi.useRealTimers() })

function fixture(firstDelta?: string) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const sent: Record<string, unknown>[] = []
  let voice: VoiceController
  const chat = new ChatController({
    async start() { return 'filler-run' },
    async *events() {
      if (firstDelta) yield { data: { event: 'message.delta', delta: firstDelta } }
      await gate
      yield { data: { event: 'run.completed', output: firstDelta ?? 'Done.' } }
    },
    async stop() {}, resetSession() {}, async prepareSession() { return 's' }
  }, s => voice.chatChanged(s))
  voice = new VoiceController(chat, m => sent.push(m as Record<string, unknown>), () => {})
  voice.receive({ type: 'ready' }); voice.mode(true)
  return { voice, chat, sent, release }
}
const fillers = (sent: Record<string, unknown>[]) => sent.filter(m => m.type === 'filler').length

test('capture processing and slow voice backend never schedule a second main-process filler', async () => {
  vi.useFakeTimers()
  const { voice, sent, release } = fixture()
  voice.receive({ type: 'state', state: 'listening' })
  voice.receive({ type: 'state', state: 'transcribing' })
  voice.receive({ type: 'state', state: 'transcribing' })
  await vi.advanceTimersByTimeAsync(2000)
  expect(fillers(sent)).toBe(0) // capture-end playback belongs entirely to the sidecar
  voice.receive({ type: 'transcript', text: 'what is up' })
  await vi.advanceTimersByTimeAsync(5000)
  expect(sent.some(m => m.type === 'speech-begin')).toBe(true)
  expect(fillers(sent)).toBe(0)
  release(); await vi.runAllTimersAsync()
})

test('typed requests and quick voice replies add no main-process filler', async () => {
  vi.useFakeTimers()
  const typed = fixture()
  void typed.chat.submit('typed question')
  await vi.advanceTimersByTimeAsync(2000)
  expect(fillers(typed.sent)).toBe(0)
  typed.release()

  const quick = fixture('Quick answer. ')
  quick.voice.receive({ type: 'state', state: 'listening' }); quick.voice.receive({ type: 'transcript', text: 'quick' })
  await vi.advanceTimersByTimeAsync(2000)
  expect(quick.sent.some(m => m.type === 'speech-append')).toBe(true)
  expect(fillers(quick.sent)).toBe(0)
  quick.release(); await vi.runAllTimersAsync()
})

test('Stop sends cancellation without a delayed filler replay', async () => {
  vi.useFakeTimers()
  const { voice, sent, release } = fixture()
  voice.receive({ type: 'state', state: 'listening' }); voice.receive({ type: 'transcript', text: 'never mind' })
  voice.stop()
  expect(sent.some(m => m.type === 'cancel')).toBe(true)
  await vi.advanceTimersByTimeAsync(2000)
  expect(fillers(sent)).toBe(0)
  release(); await vi.runAllTimersAsync()
})
