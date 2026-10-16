import { existsSync } from 'node:fs'
import { expect, test } from 'vitest'
import { ChatController } from './chat-controller'

test('accepts only final local transcript through existing gateway and speaks completed answer', async () => {
  expect(existsSync('src/main/voice-controller.ts'), 'voice controller not implemented').toBe(true)
  const { VoiceController } = await import('./voice-controller')
  const sent: unknown[] = [], submitted: string[] = []
  let voice: InstanceType<typeof VoiceController>
  const chat = new ChatController({
    async start(text) { submitted.push(text); return 'mock-run' },
    async *events() { yield { data: { event: 'run.completed', output: '**Local reply.**' }, id: '1' } },
    async stop() {}
  }, snapshot => voice.chatChanged(snapshot))
  voice = new VoiceController(chat, message => sent.push(message), () => {})
  voice.receive({ type: 'ready' })
  voice.mode(true)
  voice.receive({ type: 'state', state: 'listening' })
  voice.receive({ type: 'transcript', text: 'accepted local text', device: 'cpu' })
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(submitted).toEqual(['accepted local text'])
  expect(sent).toContainEqual({ type: 'speech-append', stream: chat.snapshot.speech!.id, seq: 0, text: 'Local reply.' })
  expect(chat.snapshot.answer).toBe('**Local reply.**')
})

test('mute, mode changes and stop fail closed for stale transcript and playback', async () => {
  const { VoiceController } = await import('./voice-controller')
  const sent: unknown[] = [], submitted: string[] = []
  const chat = new ChatController({ async start(text) { submitted.push(text); return 'run' }, async *events() {}, async stop() {} }, () => {})
  const voice = new VoiceController(chat, m => sent.push(m), () => {})
  voice.receive({ type: 'ready' }); voice.mode(true)
  voice.mute()
  voice.receive({ type: 'transcript', text: 'must not send' })
  expect(submitted).toEqual([])
  expect(voice.snapshot.mode).toBe('off')
  expect(voice.snapshot.muted).toBe(false)
  voice.mute(); voice.mode(false)
  voice.receive({ type: 'transcript', text: 'late result' })
  expect(submitted).toEqual([])
  voice.stop()
  expect(sent).toContainEqual({ type: 'cancel' })
  voice.hold(true)
  expect(sent).not.toContainEqual({ type: 'start' })
  voice.disconnected()
  expect(voice.snapshot.ready).toBe(false)
  expect(voice.snapshot.level).toBe(0)
})

test('ready clears legacy mute and cancellation blocks queued stale transcripts', async () => {
  const { VoiceController } = await import('./voice-controller')
  const sent: unknown[] = [], submitted: string[] = []
  const chat = new ChatController({ async start(text) { submitted.push(text); return 'run' }, async *events() {}, async stop() {} }, () => {})
  const voice = new VoiceController(chat, m => sent.push(m), () => {})
  voice.mute(); sent.length = 0
  voice.receive({ type: 'ready' })
  expect(sent).toContainEqual({ type: 'mute', muted: false })
  voice.mute(); voice.mode(true); voice.receive({ type: 'cancelled' })
  voice.receive({ type: 'state', state: 'listening' })
  voice.stop()
  voice.receive({ type: 'state', state: 'listening' }) // queued before cancel acknowledgment
  voice.receive({ type: 'transcript', text: 'stale queued transcript' })
  expect(submitted).toEqual([])
  voice.receive({ type: 'cancelled' })
  voice.receive({ type: 'transcript', text: 'unsolicited result' })
  expect(submitted).toEqual([])
})

test('death invalidates queued transcription and restart leaves mic mode off without hidden mute', async () => {
  const { VoiceController } = await import('./voice-controller')
  const submitted: string[] = [], sent: unknown[] = []
  const chat = new ChatController({ async start(text) { submitted.push(text); return 'run' }, async *events() {}, async stop() {} }, () => {})
  const voice = new VoiceController(chat, m => sent.push(m), () => {})
  voice.receive({ type: 'ready' }); voice.mode(true)
  voice.receive({ type: 'state', state: 'listening' })
  voice.disconnected()
  voice.receive({ type: 'transcript', text: 'queued before death' })
  expect(submitted).toEqual([])
  expect(voice.snapshot.enabled).toBe(false)
  voice.mute(); sent.length = 0
  voice.receive({ type: 'ready' })
  expect(voice.snapshot.state).toBe('idle')
  expect(voice.snapshot.notice).toBe('')
  expect(sent).toContainEqual({ type: 'mode', enabled: false })
  expect(sent).toContainEqual({ type: 'mute', muted: false })
})

test('sidecar speech rejection is a visible captions-only notice', async () => {
  const { VoiceController } = await import('./voice-controller')
  const chat = new ChatController({ async start() { return 'run' }, async *events() {}, async stop() {} }, () => {})
  const voice = new VoiceController(chat, () => {}, () => {})
  voice.receive({ type: 'ready' }); voice.mode(true)
  voice.receive({ type: 'speech-rejected' })
  expect(voice.snapshot.notice).toMatch(/speech.*limits.*captions/i)
})
