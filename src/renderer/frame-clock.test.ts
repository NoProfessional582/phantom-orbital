import { expect, it } from 'vitest'
import { FrameClock } from './frame-clock'

it('paces 60/30 fps on a 144 Hz desktop without rounding down to 48 fps', () => {
  for (const fps of [60,30]) {
    const clock = new FrameClock()
    let frames = 0
    for (let i = 0; i < 432; i++) if (clock.due(i * 1000 / 144, fps)) frames++
    expect(frames).toBe(fps * 3)
  }
})

it('does not replay missed frames after a hidden window resumes', () => {
  const clock = new FrameClock()
  expect(clock.due(0,60)).toBe(true)
  expect(clock.due(10000,60)).toBe(true)
  expect(clock.due(10001,60)).toBe(false)
})
