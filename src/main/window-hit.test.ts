import { describe, expect, it } from 'vitest'
import { orbHit } from './window-hit'

describe('native circle hit testing', () => {
  it('accepts the central sphere and passes through corners and caption area', () => {
    const bounds = { x: 300, y: 400 }
    expect(orbHit({x:460,y:551}, bounds)).toBe(true)
    expect(orbHit({x:310,y:412}, bounds)).toBe(false)
    expect(orbHit({x:460,y:750}, bounds)).toBe(false)
    expect(orbHit({x:300+160+125,y:551}, bounds)).toBe(false)
  })
})