import { expect, test } from 'vitest'
import { ChatController } from './chat-controller'
import { VoiceController } from './voice-controller'

function fixture() {
  const sent: object[] = [], submitted: string[] = []
  const chat = new ChatController({ async start(text) { submitted.push(text); return 'mock' }, async *events() {}, async stop() {} }, () => {})
  const voice = new VoiceController(chat, m => sent.push(m), () => {})
  voice.receive({ type: 'ready' }); voice.mode(true)
  return { voice, chat, sent, submitted }
}

test('deliberate enrollment uses existing PTT but never submits an enrollment transcript', async () => {
  const { voice, sent, submitted } = fixture()
  voice.enroll()
  expect(sent).toContainEqual({ type: 'enroll' })
  voice.receive({ type: 'cancelled' })
  voice.receive({ type: 'speaker', registered: false, enrolling: true, count: 0, message: 'Enrollment 0/6' })
  voice.hold(true)
  expect(sent).toContainEqual({ type: 'start' })
  voice.receive({ type: 'state', state: 'listening' })
  voice.receive({ type: 'transcript', text: 'private enrollment' })
  expect(submitted).toEqual([])
  expect(voice.snapshot.enrolling).toBe(true)
  voice.mode(false)
  expect(voice.snapshot.enrolling).toBe(false)
})

test('rejection consumes pending transcript and typed input bypasses speaker filtering', async () => {
  const { voice, chat, submitted } = fixture()
  voice.receive({ type: 'state', state: 'listening' })
  voice.receive({ type: 'speaker', registered: false, enrolling: false, count: 0, message: 'Nothing sent. Retry.' })
  voice.receive({ type: 'transcript', text: 'rejected speech' })
  expect(submitted).toEqual([])
  expect(voice.snapshot.notice).toContain('Nothing sent')
  await chat.submit('typed bypass')
  expect(submitted).toEqual(['typed bypass'])
})

test('Voice on shows not-enrolled guidance but ordinary Voice-off startup stays quiet', () => {
  const { voice } = fixture()
  voice.mode(false)
  voice.receive({ type: 'cancelled' })
  voice.receive({ type: 'speaker', registered: false, enrolling: false, count: 0, message: 'Not enrolled. Choose Enroll voice.' })
  expect(voice.snapshot.notice).toBe('')
  voice.mode(true)
  expect(voice.snapshot.notice).toContain('Not enrolled')
})
