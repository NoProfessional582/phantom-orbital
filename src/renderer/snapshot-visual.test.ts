import { expect, test } from 'vitest'
import { snapshotVisual } from './state'
import type { ChatSnapshot } from '../shared/chat'
import type { VoiceSnapshot } from '../shared/voice'

function snapshot(state: VoiceSnapshot['state'], extra: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return { state: 'idle', busy: false, stopping: false, inputOpen: false, user: '', answer: '', notice: '', voice: { mode: 'active', nextMode: 'off', activation: true, enabled: true, ready: true, muted: false, state, level: .9, notice: '', device: 'cpu', hotkeyAvailable: true, muteShortcutAvailable: true }, ...extra }
}
test.each(['arming', 'armed'] as const)('passive %s wake is visually idle and cannot drive the audio meter', state => {
  expect(snapshotVisual(snapshot(state))).toEqual({ state: 'idle', level: 0 })
})
test.each(['capturing', 'listening', 'followup'] as const)('actual %s capture retains listening graphics and level', state => {
  expect(snapshotVisual(snapshot(state))).toEqual({ state: 'listening', level: .9 })
})
test.each(['verifying', 'transcribing'] as const)('%s is transcription, not passive wake or audio capture', state => {
  expect(snapshotVisual(snapshot(state))).toEqual({ state: 'transcribing', level: 0 })
})
test('response speech retains speaking graphics and output level', () => {
  expect(snapshotVisual(snapshot('speaking'))).toEqual({ state: 'speaking', level: .9 })
})
test.each(['thinking', 'working', 'approval', 'offline'] as const)('backend busy %s takes precedence over stale local capturing', state => {
  expect(snapshotVisual(snapshot('capturing', { busy: true, state }))).toEqual({ state, level: 0 })
})
test('local errors remain honest while voice is available, and disabled voice follows backend', () => {
  const s = snapshot('error')
  expect(snapshotVisual(s)).toEqual({ state: 'offline', level: 0 })
  s.voice!.enabled = false
  expect(snapshotVisual(s)).toEqual({ state: 'idle', level: 0 })
})
