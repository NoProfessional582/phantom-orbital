import { expect, test } from 'vitest'
import { ChatController } from './chat-controller'
import { VoiceController } from './voice-controller'
import { validVoiceMode } from '../shared/voice'

function fixture() {
  const sent: any[] = [], submitted: string[] = []
  const chat = new ChatController({ async start(text) { submitted.push(text); return 'run' }, async *events() {}, async stop() {} }, () => {})
  const voice = new VoiceController(chat, m => sent.push(m), () => {})
  voice.receive({ type: 'ready' })
  voice.receive({ type: 'speaker', registered: true, enrolling: false, count: 0, message: '' })
  return { voice, chat, sent, submitted }
}

test('cycles internal off/voice/active modes; pending activation and late acknowledgements keep the next action truthful', () => {
  const { voice, chat, sent, submitted } = fixture()
  expect(voice.snapshot.mode).toBe('off')
  expect(voice.snapshot.nextMode).toBe('voice') // displayed as PTT
  voice.cycleMode()
  expect(voice.snapshot.mode).toBe('voice')
  expect(voice.snapshot.nextMode).toBe('active') // displayed as Voice
  chat.snapshot.busy = true
  voice.cycleMode()
  const active = [...sent].reverse().find(m => m.type === 'voice-mode')
  expect(active.mode).toBe('active')
  expect(voice.snapshot.mode).toBe('voice') // activation is not yet confirmed
  expect(voice.snapshot.nextMode).toBe('off')
  voice.cycleMode()
  const off = [...sent].reverse().find(m => m.type === 'voice-mode')
  expect(off.mode).toBe('off')
  expect(voice.snapshot.nextMode).toBe('voice')
  voice.receive({ type: 'mode-ready', revision: active.revision, mode: 'active' })
  voice.receive({ type: 'state', revision: active.revision, state: 'capturing' })
  voice.receive({ type: 'transcript', revision: active.revision, text: 'late capture' })
  expect(voice.snapshot.mode).toBe('off')
  expect(voice.snapshot.enabled).toBe(false)
  expect(voice.snapshot.activation).toBe(false)
  expect(submitted).toEqual([])
  voice.receive({ type: 'mode-ready', revision: off.revision, mode: 'off' })
  expect(voice.snapshot.mode).toBe('off')
})

test('active requires registration and successful listener confirmation; failure falls back honestly and cycles off', () => {
  const { voice, sent } = fixture()
  voice.cycleMode(); voice.cycleMode()
  const revision = [...sent].reverse().find(m => m.type === 'voice-mode').revision
  voice.receive({ type: 'mode-ready', revision, mode: 'active' })
  expect(voice.snapshot.mode).toBe('active')
  voice.setMode('active') // legacy callers cannot turn an armed listener into hidden pending Voice
  expect(voice.snapshot.mode).toBe('active')
  voice.receive({ type: 'wake-error', revision, message: 'Missing local model' })
  expect(voice.snapshot.mode).toBe('voice')
  expect(voice.snapshot.notice).toContain('Missing local model')
  expect(voice.snapshot.nextMode).toBe('off')
  voice.receive({ type: 'speaker', registered: true, enrolling: false, count: 0, message: 'Voice filter ready.' })
  expect(voice.snapshot.notice).toContain('Missing local model')
  voice.cycleMode()
  expect(voice.snapshot.mode).toBe('off')
  voice.receive({ type: 'speaker', registered: false, enrolling: false, count: 0, message: '' })
  voice.cycleMode(); voice.cycleMode()
  expect(voice.snapshot.mode).toBe('voice')
  expect(voice.snapshot.notice).toMatch(/enroll/i)
  voice.cycleMode()
  expect(voice.snapshot.mode).toBe('off')
})

test('emergency mute is Off, never a hidden fourth state, and recovery remains Off', () => {
  const { voice, sent } = fixture()
  voice.cycleMode(); voice.mute()
  expect(voice.snapshot.mode).toBe('off')
  expect(voice.snapshot.muted).toBe(false)
  voice.cycleMode()
  expect(voice.snapshot.mode).toBe('voice')
  voice.disconnected(); voice.receive({ type: 'ready' })
  expect(voice.snapshot.mode).toBe('off')
  expect([...sent].reverse().find(m => m.type === 'voice-mode')?.mode).toBe('off')
})

test('legacy activation uses the same confirmed mode and invalid mode payloads do nothing', () => {
  const { voice, sent } = fixture()
  voice.mode(true); voice.activation(true)
  expect(voice.snapshot.pendingMode).toBe('active')
  expect(voice.snapshot.mode).toBe('voice')
  for (const invalid of [true, null, {}, 'ACTIVE', 'muted']) {
    expect(validVoiceMode(invalid)).toBe(false)
    const before = sent.length
    voice.setMode(invalid)
    expect(sent).toHaveLength(before)
  }
})
