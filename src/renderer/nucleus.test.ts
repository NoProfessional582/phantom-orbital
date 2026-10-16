import * as THREE from 'three'
import { expect, it } from 'vitest'
import { createCore } from './orb'

it('places a genuinely volumetric luminous nucleus at the sphere origin', () => {
  const core = createCore()
  expect(core.geometry).toBeInstanceOf(THREE.SphereGeometry)
  expect(core.position.toArray()).toEqual([0, 0, 0])
  core.geometry.computeBoundingBox()
  const bounds = core.geometry.boundingBox!
  expect(bounds.min.z).toBeLessThan(-.1)
  expect(bounds.max.z).toBeGreaterThan(.1)
  expect(core.material.vertexShader).toContain('normalMatrix*normal')
  core.geometry.dispose(); core.material.dispose()
})
