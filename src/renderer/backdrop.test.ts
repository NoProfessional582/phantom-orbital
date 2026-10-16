import * as THREE from 'three'
import { expect, it } from 'vitest'
import { createBackdrop, createOuterShadow, updateOuterShadow } from './orb'
import { STATES, target } from './state'

it('backs the body with 75 percent navy and feathers to transparent within native hit geometry', () => {
  const backing = createBackdrop()
  const texture = backing.material.map!
  const { data, width, height } = texture.image as { data: Uint8Array; width: number; height: number }
  const rgba = (radius: number) => {
    const x = Math.min(width - 1, Math.floor(width / 2 + radius / 1.12 * width / 2))
    const y = Math.floor(height / 2)
    return Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4))
  }
  expect(rgba(0)[3]).toBe(191)
  expect(rgba(.88)[3]).toBe(191)
  expect(Math.max(...Array.from(data).filter((_,i)=>i%4===3))).toBe(191)
  expect(rgba(0)[2]).toBeGreaterThan(rgba(0)[0])
  expect(rgba(0).slice(0,3)).toEqual([12,24,61])
  expect(rgba(.88)[2]).toBeLessThan(rgba(0)[2])
  expect(Math.max(...rgba(0).slice(0,3))).toBeLessThan(65)
  expect(rgba(1)[3]).toBeGreaterThan(30)
  expect(rgba(1)[3]).toBeLessThan(200)
  expect(rgba(1.12)[3]).toBe(0)
  for(const index of [0,width-1,(height-1)*width,width*height-1]) expect(data[index*4+3]).toBe(0)
  expect(backing.material.transparent).toBe(true)
  expect(backing.material.blending).toBe(THREE.NormalBlending)
  expect(backing.material.depthWrite).toBe(false)
  expect(backing.material.depthTest).toBe(false)
  expect(backing.renderOrder).toBeLessThan(-2)
  for (const state of STATES) {
    const radiusPixels = 1.12 * target(state).scale * 1.02 / (5.1 * Math.tan(37 * Math.PI / 360)) * 160
    expect(radiusPixels + 9).toBeLessThan(125 * .95)
  }
  texture.dispose(); backing.geometry.dispose(); backing.material.dispose()
})

it('adds a low-opacity navy fringe with a continuous feather and transparent edges', () => {
  const shadow = createOuterShadow()
  const texture = shadow.material.map!
  const { data, width } = texture.image as { data: Uint8Array; width: number }
  const alpha = (radius: number) => data[(Math.floor(width / 2) * width + Math.min(width - 1, Math.floor((1 + radius) * width / 2))) * 4 + 3]
  // No opacity stacking underneath the backing interior.
  expect(alpha(0)).toBe(0)
  expect(alpha(.70)).toBe(0)
  expect(Array.from(data.slice((width / 2 * width + width / 2) * 4, (width / 2 * width + width / 2) * 4 + 3))).toEqual([3, 8, 22])
  let previous = alpha(.72)
  for (let r = .73; r <= .82; r += .01) {
    const next=alpha(r)
    expect(next).toBeGreaterThanOrEqual(previous)
    expect(next-previous).toBeLessThan(12)
    previous=next
  }
  previous=alpha(.84)
  for (let r = .85; r <= 1; r += .01) {
    const next = alpha(r)
    expect(next).toBeLessThanOrEqual(previous)
    expect(previous - next).toBeLessThan(10)
    previous = next
  }
  expect(alpha(.8)).toBeGreaterThan(48)
  expect(alpha(.8)).toBeLessThan(54)
  expect(alpha(1)).toBe(0)
  expect(data[3]).toBe(0)
  expect(shadow.material.depthWrite).toBe(false)
  expect(shadow.material.depthTest).toBe(false)
  const backing = createBackdrop()
  expect(shadow.renderOrder).toBeLessThan(backing.renderOrder)
  backing.material.map!.dispose(); backing.geometry.dispose(); backing.material.dispose()
  texture.dispose(); shadow.geometry.dispose(); shadow.material.dispose()
})

it('keeps the shadow a narrow body-sized fringe independent of expanded fabric', () => {
  const shadow = createOuterShadow()
  updateOuterShadow(shadow, target('idle').scale)
  const idleRadius = shadow.scale.x
  updateOuterShadow(shadow, target('speaking').scale)
  const activeRadius = shadow.scale.x
  expect(activeRadius / target('speaking').scale).toBeCloseTo(1.18)
  expect(idleRadius / target('idle').scale).toBeCloseTo(1.18)
  for (const state of STATES) {
    updateOuterShadow(shadow, target(state).scale)
    const pixels = shadow.scale.x / (5.1 * Math.tan(37 * Math.PI / 360)) * 160
    expect(pixels).toBeLessThan(112)
    expect(shadow.scale.y).toBe(shadow.scale.x)
  }
  updateOuterShadow(shadow, (target('idle').scale + target('speaking').scale) / 2)
  expect(shadow.scale.x).toBeCloseTo((idleRadius + activeRadius) / 2, 8)
  shadow.material.map!.dispose(); shadow.geometry.dispose(); shadow.material.dispose()
})
