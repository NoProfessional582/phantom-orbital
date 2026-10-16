import { expect, test } from 'vitest'
import { TranscriptHistory, nearTranscriptBottom } from './transcript'
import type { ChatSnapshot } from '../shared/chat'

const snapshot = (id: string | undefined, user: string, answer: string, overrides: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  ...(id ? { speech: { id, text: answer, phase: 'stream' as const } } : {}),
  state: 'thinking', user, answer, notice: '', busy: true, stopping: false, inputOpen: true, ...overrides
})

test('stream snapshots update one stable turn and later turns preserve order', () => {
  const history = new TranscriptHistory()
  expect(history.apply(snapshot('run-1', 'first prompt', '')).added).toBe(true)
  history.apply(snapshot('run-1', 'first prompt', 'partial'))
  history.apply(snapshot('run-1', 'first prompt', 'complete', { busy: false }))
  expect(history.apply(snapshot('run-2', 'second prompt', '')).added).toBe(true)
  history.apply(snapshot('run-2', 'second prompt', 'reply two'))
  expect(history.turns).toEqual([
    { id: 'run-1', prompt: 'first prompt', reply: 'complete' },
    { id: 'run-2', prompt: 'second prompt', reply: 'reply two' }
  ])
  expect(history.apply(snapshot('run-2', 'second prompt', 'reply two')).added).toBe(false)
})

test('only an identity-free empty reset or explicit local dismiss clears displayed turns', () => {
  const history = new TranscriptHistory()
  history.apply(snapshot('run-1', 'prompt', 'reply', { busy: false }))
  expect(history.apply(snapshot(undefined, '', '', { busy: false, notice: 'New conversation.' })).reset).toBe(true)
  expect(history.turns).toEqual([])
  expect(history.apply(snapshot('run-1', 'stale prompt', 'stale reply')).added).toBe(false)
  history.apply(snapshot('run-2', 'keep backend context', ''))
  history.dismiss()
  expect(history.apply(snapshot('run-2', 'dismissed stale prompt', 'stale reply')).added).toBe(false)
  expect(history.turns).toEqual([])
})

test('near-bottom follow is bounded and scrolled-back readers are not forced down', () => {
  expect(nearTranscriptBottom(900, 300, 568)).toBe(true)
  expect(nearTranscriptBottom(900, 200, 568)).toBe(false)
})
