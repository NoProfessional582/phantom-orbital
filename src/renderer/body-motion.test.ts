import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { expect, it } from 'vitest'
import * as orb from './orb'
import { STATES, target } from './state'

it('keeps body, nucleus parent, backing and shadow constant through every settled state', () => {
  expect(orb).toHaveProperty('updateBodyMotion')
  const globe=new THREE.Group(), backing=new THREE.Object3D(), shadow=new THREE.Object3D(), halo=new THREE.Object3D()
  const core=orb.createCore(); globe.add(core)
  for(const state of STATES) for(const phase of [0,.2,1,3,5,8]) {
    const v=target(state)
    orb.updateBodyMotion(globe,backing,shadow,halo,v.scale,phase)
    expect(globe.scale.toArray()).toEqual([v.scale,v.scale,v.scale])
    expect(backing.scale.toArray()).toEqual(globe.scale.toArray())
    expect(halo.scale.toArray()).toEqual(globe.scale.toArray())
    expect(shadow.scale.x).toBeCloseTo(1.18*v.scale)
    expect(core.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([0,0,0])
    expect(globe.rotation.y).toBe(phase)
  }
  const source=readFileSync(new URL('./orb.ts',import.meta.url),'utf8')
  expect(source).toContain('springs[p].step(t[p],dt)')
  expect(source).toContain('updateBodyMotion(globe,backing,outerShadow,coreGlow,v.scale,motion.spin)')
  const glow=orb.createCoreGlow()
  expect(glow.material.fragmentShader).not.toContain('time*')
  expect(source).toContain('coreUniforms.strength.value=v.core')
  expect(source).toContain('core.scale.setScalar(1+pulse*1.6)')
  expect(source).toContain('coreGlow.scale.setScalar(v.scale*(1+pulse*.8))')
  glow.geometry.dispose();glow.material.dispose()
  core.geometry.dispose();core.material.dispose()
})
