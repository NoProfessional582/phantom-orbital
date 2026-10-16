import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import * as orb from './orb'

it('retains the brighter soft white connected nucleus with blue galaxy and radiance shoulder', () => {
  expect(orb).toHaveProperty('createCore')
  const core = orb.createCore()
  expect(core.material.uniforms.brightness.value).toBeCloseTo(2.5)
  expect(core.material.uniforms.whiteness.value).toBe(1)
  expect(core.material.fragmentShader).toContain('*strength*brightness')
  expect(core.material.fragmentShader).toContain('vec3(.025,.28,.72)')
  expect(core.material.fragmentShader).toContain('vec3(.94,.97,1.)')
  expect(core.material.fragmentShader).toContain('smoothstep(0.,.9,facing)*pow(facing,4.)')
  expect(core.material.fragmentShader).toContain('1.-exp(-peak/.48)')
  const halo=orb.createCoreGlow()
  expect(halo.material.uniforms.brightness.value).toBe(1.85)
  expect(halo.material.uniforms.whiteness.value).toBe(1)
  expect(halo.material.fragmentShader).toContain('whiteness*exp(-r*32.)')
  halo.geometry.dispose();halo.material.dispose()
  core.geometry.dispose(); core.material.dispose()
})

it('omits the floor reflection while retaining native hover controls', () => {
  const source = readFileSync(new URL('./orb.ts', import.meta.url), 'utf8')
  expect(source).not.toContain('floor.position')
  expect(source).not.toContain('PlaneGeometry(2.5,.42)')
  const ui = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  expect(ui).toContain("controls.className = 'orb-controls'")
})
