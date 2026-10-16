import { expect, test } from 'vitest'
import { ChatController } from './chat-controller'
import { VoiceController } from './voice-controller'

function fixture() {
  const sent: object[] = [], submitted: string[] = []
  const chat = new ChatController({ async start(text) { submitted.push(text); return 'mock' }, async *events() {}, async stop() {} }, () => {})
  const voice = new VoiceController(chat, m => sent.push(m), () => {})
  voice.receive({ type: 'ready' }); voice.mode(true)
  voice.receive({ type: 'speaker', registered: true, enrolling: false, count: 0, message: '' })
  return { voice, chat, sent, submitted }
}

function confirmActive(voice: VoiceController, sent: object[]) {
  const mode = [...sent].reverse().find(m => (m as {type: string}).type === 'voice-mode') as { revision: number }
  voice.receive({ type: 'mode-ready', mode: 'active', revision: mode.revision })
}

test('activation is explicit, receives a verified capture, and only sends command text', () => {
  const { voice, sent, submitted } = fixture()
  expect(voice.snapshot.activation).toBe(false)
  voice.activation(true)
  confirmActive(voice, sent)
  expect(voice.snapshot.mode).toBe('active')
  voice.receive({ type: 'state', state: 'armed' })
  voice.receive({ type: 'transcript', text: 'stale' })
  expect(submitted).toEqual([])
  voice.receive({ type: 'state', state: 'capturing' })
  voice.receive({ type: 'state', state: 'verifying' })
  voice.receive({ type: 'transcript', text: 'tell me a story', device: 'cpu' })
  expect(submitted).toEqual(['tell me a story'])
})

test('mute, stop, recovery and ready never restore activation or accept late captures', () => {
  for (const action of ['mute', 'stop', 'disconnected'] as const) {
    const { voice, submitted } = fixture()
    voice.activation(true)
    voice.receive({ type: 'state', state: 'capturing' })
    voice[action]()
    voice.receive({ type: 'state', state: 'verifying' })
    voice.receive({ type: 'transcript', text: 'stale' })
    expect(submitted).toEqual([])
    expect(voice.snapshot.activation).toBe(false)
    voice.receive({ type: 'ready' })
    expect(voice.snapshot.activation).toBe(false)
  }
})

test('PTT may take armed ownership but never interrupts wake tail or playback gaps', () => {
  const { voice, sent } = fixture()
  voice.activation(true)
  confirmActive(voice, sent)
  voice.receive({ type: 'state', state: 'armed' })
  voice.hold(true)
  expect(sent.at(-1)).toEqual({ type: 'start' })
  voice.receive({ type: 'state', state: 'capturing' })
  sent.length = 0
  voice.hold(true); voice.hold(false)
  expect(sent).toEqual([{ type: 'release' }])
})
