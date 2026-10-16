import { describe, expect, it } from 'vitest'
import { STATES, target, ribbonPulse, Spring, smoothLevel } from './state'

describe('orb state targets', () => {
  it('maps all nine states to the specified parameter values', () => {
    expect(STATES).toEqual(['idle','listening','transcribing','thinking','working','speaking','approval','offline','muted'])
    expect(STATES.map(s => target(s).scale)).toEqual([.90,.90,.90,.90,.90,.90,.92,.80,.82])
    expect(STATES.map(s => target(s).core)).toEqual([.85,.85,.85,.85,.85,.85,.70,.30,.85])
    expect(STATES.map(s => target(s).rim)).toEqual([.75,.75,.75,.75,.75,.75,.80,.30,.40])
    expect(STATES.map(s => target(s).lattice)).toEqual([.10,.10,.10,.10,.10,.10,.10,.04,.05])
    expect(STATES.map(s => target(s).spin)).toEqual([.20,.20,.20,.20,.20,.20,.20,.20,.20])
    expect(STATES.map(s => target(s).rings)).toEqual([.60,.80,.60,.80,.90,.90,.90,.30,.40])
    expect(STATES.map(s => target(s).ringSpeed)).toEqual([.30,.30,.30,.30,.30,.30,.30,.30,.30])
    expect(STATES.map(s => target(s).amber)).toEqual([.35,.65,.35,.70,.80,.85,.90,0,.05])
    expect(STATES.map(s => target(s).ribbon)).toEqual([.75,.90,.75,.95,1,1,.75,.18,.25])
    expect(STATES.map(s => target(s).ribbonSpread)).toEqual([.50,.65,.50,.70,.75,.85,.50,.10,.15])
    expect(STATES.map(s => target(s).sparks)).toEqual([.20,.25,.20,.30,.45,.50,.20,0,0])
    expect(STATES.map(s => target(s).saturation)).toEqual([1,1,1,1,1,1,1,.15,.60])
    expect(STATES.map(s => target(s).audioGain)).toEqual([0,1,0,0,0,1,0,0,0])
    expect(STATES.map(s => target(s).ribbonSpeed)).toEqual([.30,.65,.30,.80,1.2,1.2,.30,.30,.30])
  })
  it('keeps every state target independent', () => {
    const a = target('idle'); a.core = 0
    expect(target('idle').core).toBe(.85)
  })
})

describe('motion', () => {
  it('converges without snapping or overshooting', () => {
    const s = new Spring(0, .18)
    const first = s.step(1, 1/60)
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(1)
    for (let n = 0; n < 360; n++) s.step(1, 1/60)
    expect(s.value).toBeCloseTo(1, 5)
  })
  it('gives the nucleus a broad four-second activity crest without pulsing inactive states', () => {
    for(const state of ['listening','thinking','working','speaking'] as const) {
      const base=target(state).ribbon
      expect(ribbonPulse(state,0,base)).toBe(base)
      expect(ribbonPulse(state,2,base)).toBeCloseTo(base+.24)
      expect(ribbonPulse(state,1.5,base)).toBeCloseTo(base+.24)
      expect(ribbonPulse(state,4,base)).toBeCloseTo(base)
      expect(ribbonPulse(state,6,base)).toBeCloseTo(base+.24)
    }
    for(const state of ['idle','transcribing','muted','offline'] as const) for(const time of [0,1,2,3,4])
      expect(ribbonPulse(state,time,target(state).ribbon)).toBe(target(state).ribbon)
  })
  it('uses faster attack than release and perceptual mapping', () => {
    const up = smoothLevel(0, 1, .03)
    const down = smoothLevel(1, 0, .03)
    expect(up).toBeGreaterThan(1-down)
    expect(smoothLevel(0, 0, .03)).toBe(0)
  })
})
