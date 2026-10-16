import { expect, it } from 'vitest'
import { galaxyGeometry, PALETTE } from './galaxy'

it('creates a bounded deterministic spiral star field with depth and varied stars', () => {
  const a = galaxyGeometry(), b = galaxyGeometry()
  const positions = a.getAttribute('position'), sizes = a.getAttribute('size'), seeds = a.getAttribute('seed')
  expect(positions.count).toBe(720)
  expect(Array.from(positions.array)).toEqual(Array.from(b.getAttribute('position').array))
  const depths: number[] = [], radii: number[] = [], diameters: number[] = []
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i)
    radii.push(Math.hypot(x,y,z)); depths.push(z); diameters.push(sizes.getX(i))
    expect(seeds.getX(i)).toBeGreaterThanOrEqual(0)
    expect(seeds.getX(i)).toBeLessThan(1)
  }
  expect(Math.max(...radii)).toBeLessThan(.94)
  expect(Math.max(...depths) - Math.min(...depths)).toBeGreaterThan(.8)
  expect(Math.max(...diameters) / Math.min(...diameters)).toBeGreaterThan(3)
  expect(radii.filter(r => r < .5).length).toBeGreaterThan(200)
  expect(PALETTE.blue).toBe('#0078d4')
  expect(PALETTE.ink).toBe('#102e62')
  expect(PALETTE.orange).toBe('#f58220')
  expect(PALETTE.gold).toBe('#ffca45')
  a.dispose(); b.dispose()
})
