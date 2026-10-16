import { expect, test } from 'vitest'
import { stackTop } from './chat-layout'

test('chat stack begins one compact gap after the actual toolbar bottom', () => {
  expect(stackTop({ bottom: 293 }, 8)).toBe(301)
  expect(stackTop({ bottom: 310 }, 8)).toBe(318)
})
