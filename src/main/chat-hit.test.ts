import { expect, test } from 'vitest'
import { chatHit, validGeometry } from './chat-hit'
test('visible controls, captions and text box accept input, transparent corners stay click-through', () => {
  expect(chatHit({ x: 30, y: 310 }, { x: 0, y: 0 }, true, true, false)).toBe(false)
  expect(chatHit({ x: 30, y: 480 }, { x: 0, y: 0 }, true, true, false)).toBe(false)
  expect(chatHit({ x: 30, y: 310 }, { x: 0, y: 0 }, true, true, true)).toBe(true)
  expect(chatHit({ x: 14, y: 277 }, { x: 0, y: 0 }, false, false)).toBe(true)
  expect(chatHit({ x: 30, y: 480 }, { x: 0, y: 0 }, true, true)).toBe(true)
  expect(chatHit({ x: 30, y: 350 }, { x: 0, y: 0 }, false, true)).toBe(false)
  expect(chatHit({ x: 30, y: 380 }, { x: 0, y: 0 }, false, true)).toBe(true)
  expect(chatHit({ x: 30, y: 480 }, { x: 0, y: 0 }, false, true)).toBe(false)
  expect(chatHit({ x: 0, y: 0 }, { x: 0, y: 0 }, true, true)).toBe(false)
  expect(chatHit({ x: 319, y: 519 }, { x: 0, y: 0 }, true, true)).toBe(false)
  expect(chatHit({ x: 330, y: 480 }, { x: 300, y: 100 }, false, true)).toBe(true)
})

test('reported composer and menu bounds drive native hit testing only while visible', () => {
  const geometry = { controls: { x: 20, y: 265, width: 280, height: 36 }, captions: { x: 16, y: 310, width: 288, height: 120 }, input: { x: 16, y: 436, width: 288, height: 38 }, menu: { x: 170, y: 300, width: 140, height: 100 } }
  expect(chatHit({ x: 200, y: 320 }, { x: 0, y: 0 }, false, false, true, geometry)).toBe(true)
  expect(chatHit({ x: 40, y: 450 }, { x: 0, y: 0 }, true, false, true, geometry)).toBe(true)
  expect(chatHit({ x: 40, y: 450 }, { x: 0, y: 0 }, false, false, true, geometry)).toBe(false)
  expect(chatHit({ x: 200, y: 320 }, { x: 0, y: 0 }, false, false, false, geometry)).toBe(false)
  expect(validGeometry(geometry)).toBe(true)
  expect(validGeometry({ ...geometry, menu: { x: 300, y: 490, width: 40, height: 40 } })).toBe(false)
  expect(validGeometry({ ...geometry, input: { x: NaN, y: 0, width: 20, height: 20 } })).toBe(false)
})
