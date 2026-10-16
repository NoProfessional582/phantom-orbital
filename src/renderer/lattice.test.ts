import * as THREE from 'three'
import { expect, it } from 'vitest'
import { createSphereLattice } from './orb'

it('restores a blue geodesic mesh with readable front-facing lines alongside galaxy stars', () => {
  const lattice = createSphereLattice()
  expect(lattice.geometry.getAttribute('position').count).toBe(1920)
  expect(lattice.geometry.index!.count).toBe(2880)
  expect(lattice.geometry.getAttribute('edge').array.slice(0,4)).toEqual(new Float32Array([-1,1,-1,1]))
  expect(lattice.material.uniforms.strokeWidth.value).toBe(2)
  expect(lattice.material.vertexShader).toContain('edge*strokeWidth/resolution*clip.w')
  expect(lattice.material.uniforms.strength.value).toBeGreaterThanOrEqual(.45)
  expect(lattice.material.uniforms.brightness?.value).toBeCloseTo(1.18)
  expect(lattice.material.fragmentShader).toContain('*brightness')
  expect(lattice.material.fragmentShader).toContain('facing')
  expect(lattice.material.fragmentShader).toContain('discard')
  expect(lattice.material.blending).toBe(THREE.CustomBlending)
  expect(lattice.material.depthWrite).toBe(false)
  lattice.geometry.dispose(); lattice.material.dispose()
})
