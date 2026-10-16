import { expect, it } from 'vitest'
import { dragPosition } from './window-position'

it('moves from the initial window position without accumulating pointer displacement', () => {
  const origin = { x: 100, y: 200 }, pointer = { x: 400, y: 500 }
  expect(dragPosition(origin, pointer, { x: 420, y: 510 })).toEqual({ x: 120, y: 210 })
  expect(dragPosition(origin, pointer, { x: 430, y: 520 })).toEqual({ x: 130, y: 220 })
})
