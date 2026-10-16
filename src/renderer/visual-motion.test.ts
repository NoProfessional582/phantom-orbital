import { expect, it } from 'vitest'
import * as clocks from './frame-clock'

it('advances independent 2x body and 3x fabric clocks without rescaling real delta', () => {
  expect(clocks).toHaveProperty('VisualClock')
  const clock = new clocks.VisualClock()
  clock.step(.1, .2, .08)
  expect(clock.body).toBeCloseTo(.2)
  expect(clock.spin).toBeCloseTo(.016)
  expect(clock.fabric).toBeCloseTo(.21)
  expect(clock.rings).toBeCloseTo(-.009)
  expect(clock.orbit).toBeCloseTo(-.21)
  clock.step(.1, .8, .6)
  expect(clock.body).toBeCloseTo(.4)
  expect(clock.spin).toBeCloseTo(.136)
  expect(clock.fabric).toBeCloseTo(.6)
  expect(clock.rings).toBeCloseTo(-.045)
  expect(clock.orbit).toBeCloseTo(-.6)
})

it('counter-rotates thin-ring circulation faster than body spin without state phase jumps', () => {
  const clock=new clocks.VisualClock()
  for(const [ring,spin] of [[.15,.05],[1.2,.8],[.02,.02],[.8,.6]]) {
    const before={body:clock.spin,outer:clock.orbit}
    clock.step(.1,ring,spin)
    expect(clock.spin).toBeGreaterThan(before.body)
    expect(clock.orbit).toBeLessThan(before.outer)
    expect(Math.abs(clock.orbit-before.outer)).toBeGreaterThan(clock.spin-before.body)
  }
})
