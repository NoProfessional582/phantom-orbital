import type { ChatSnapshot } from '../shared/chat'

export const STATES = ['idle','listening','transcribing','thinking','working','speaking','approval','offline','muted'] as const
export type OrbState = typeof STATES[number]
export function snapshotVisual(snapshot: ChatSnapshot): { state: OrbState; level: number } {
  const voice = snapshot.voice
  if (snapshot.busy || !voice?.enabled) return { state: snapshot.state, level: 0 }
  const local = voice.state
  const state: OrbState = local === 'armed' || local === 'arming' ? 'idle'
    : local === 'capturing' || local === 'followup' ? 'listening'
    : local === 'verifying' ? 'transcribing' : local === 'error' ? 'offline' : local
  return { state, level: state === 'listening' || state === 'speaking' ? voice.level : 0 }
}
export const PARAMS = ['scale','core','rim','lattice','spin','rings','ringSpeed','amber','ribbon','ribbonSpread','sparks','saturation','audioGain','ribbonSpeed'] as const
export type Param = typeof PARAMS[number]
export type Targets = Record<Param, number>
const rows: number[][] = [
  [.90,.90,.90,.90,.90,.90,.92,.80,.82],
  [.85,.85,.85,.85,.85,.85,.70,.30,.85],
  [.75,.75,.75,.75,.75,.75,.80,.30,.40],
  [.10,.10,.10,.10,.10,.10,.10,.04,.05],
  [.20,.20,.20,.20,.20,.20,.20,.20,.20],
  [.60,.80,.60,.80,.90,.90,.90,.30,.40],
  [.30,.30,.30,.30,.30,.30,.30,.30,.30],
  [.35,.65,.35,.70,.80,.85,.90,0,.05],
  [.75,.90,.75,.95,1,1,.75,.18,.25],
  [.50,.65,.50,.70,.75,.85,.50,.10,.15],
  [.20,.25,.20,.30,.45,.50,.20,0,0],
  [1,1,1,1,1,1,1,.15,.60],
  [0,1,0,0,0,1,0,0,0],
  [.30,.65,.30,.80,1.2,1.2,.30,.30,.30]
]
export function target(state: OrbState): Targets {
  const index = STATES.indexOf(state)
  return Object.fromEntries(PARAMS.map((name, row) => [name, rows[row][index]])) as Targets
}
export function ribbonPulse(state: OrbState, seconds: number, strength: number): number {
  if (!['listening','thinking','working','speaking','approval'].includes(state)) return strength
  if (state === 'approval') return strength + .09*Math.min(1,strength/.55)*Math.sin(2*Math.PI*seconds)
  // Four real seconds per breath with a broad, smoothly sustained crest.
  const breath = (1-Math.cos(2*Math.PI*seconds/4))*.5
  const ramp = Math.max(0,Math.min(1,(breath-.12)/.70))
  return strength + .24*Math.min(1,strength/.55)*ramp*ramp*(3-2*ramp)
}
export class Spring {
  velocity = 0
  constructor(public value: number, public halfLife = .18) {}
  step(goal: number, dt: number): number {
    const omega = 1.67834699001666 / this.halfLife
    const e = Math.exp(-omega * dt)
    const displacement = this.value - goal
    const term = (this.velocity + omega * displacement) * dt
    this.value = goal + (displacement + term) * e
    this.velocity = (this.velocity - omega * term) * e
    return this.value
  }
}
export function smoothLevel(previous: number, rms: number, dt: number): number {
  const mapped = Math.pow(Math.max(0, Math.min(1, rms)), .6)
  const tau = mapped > previous ? .03 : .15
  return previous + (mapped - previous) * (1 - Math.exp(-dt / tau))
}
