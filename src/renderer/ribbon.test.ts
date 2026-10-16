import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ribbonGeometry, ribbonPosition, ringGeometry, ribbonBasePosition } from './ribbon'
import { createRibbonFabric, createBackdrop, createOuterShadow } from './orb'

describe('orb ribbon fabric', () => {
  it('flows fabric in place independently of thin-ring counter-orbit', () => {
    const {front,rear}=createRibbonFabric(0)
    expect(front.material.uniforms).not.toHaveProperty('orbit')
    expect(rear.material.uniforms).not.toHaveProperty('orbit')
    expect(front.material.vertexShader).not.toContain('cos(orbit)')
    const source=readFileSync(new URL('./orb.ts',import.meta.url),'utf8')
    const update=source.split('ribbons.forEach')[1].split('sparkMat.uniforms')[0]
    expect(update).not.toContain('motion.orbit')
    expect(update).toContain('motion.fabric')
    const base=ribbonPosition(40,12,0,.85,1,2,1)
    expect(ribbonPosition(40,12,0,.85,1,3,1)).not.toEqual(base)
    expect(front.position.toArray()).toEqual([0,0,0])
    expect(front.rotation.toArray().slice(0,3)).toEqual([0,0,0])
    front.geometry.dispose();front.material.dispose();rear.material.dispose()
  })
  it('preserves opposite centerline points through intentional traveling deformation', () => {
    for (const time of [0,.7,2,5]) for(let band=0;band<3;band++) for(let i=0;i<128;i++) {
      const p=ribbonPosition(i,11.5,band,.85,1,time,1)
      const opposite=ribbonPosition(i+128,11.5,band,.85,1,time,1)
      p.forEach((v,axis)=>expect(v+opposite[axis]).toBeCloseTo(0,6))
    }
  })
  it('keeps the whole traveling-wave fabric centered without one-sided drift', () => {
    for (const time of [0,.7,2,5]) for (let band=0;band<3;band++) {
      const sum=[0,0,0]
      for(let column=0;column<256;column++) for(let row=0;row<24;row++) {
        ribbonPosition(column,row,band,.85,1,time,1).forEach((v,i)=>sum[i]+=v)
      }
      sum.forEach(v=>expect(v/(256*24)).toBeCloseTo(0,6))
    }
  })
  it('centers circular ring and fabric bases on the galaxy origin before 3D tilt', () => {
    for (let band = 0; band < 3; band++) {
      const ring = ringGeometry(band), p = ring.getAttribute('position')
      for (let i = 0; i < 256; i++) {
        const opposite = (i + 128) % 256
        for (let axis = 0; axis < 3; axis++) expect(p.getComponent(i*4, axis) + p.getComponent(opposite*4, axis)).toBeCloseTo(0, 6)
        expect(Math.hypot(p.getX(i*4),p.getY(i*4))).toBeCloseTo(band === 2 ? 1.22 : 1.28, 6)
        expect(p.getX(i*4)).toBe(p.getX(i*4+1))
        expect(p.getY(i*4)).toBe(p.getY(i*4+1))
        expect(ring.getAttribute('uv').getX(i*4)).toBeCloseTo(i/256)
        expect(ring.getAttribute('uv').getX(i*4+2)).toBeCloseTo((i+1)/256)
        const base = ribbonBasePosition(i, band, .85)
        const back = ribbonBasePosition(opposite, band, .85)
        expect(Math.hypot(...base)).toBeCloseTo(1.13+.85*.14+band*.045, 6)
        base.forEach((value, axis) => expect(value+back[axis]).toBeCloseTo(0, 6))
      }
      ring.dispose()
    }
  })
  it('composites actual rear arcs between shadow and body, with front arcs above the shell', () => {
    const { front, rear } = createRibbonFabric(0)
    const backing = createBackdrop(), shadow = createOuterShadow()
    expect(rear.renderOrder).toBeGreaterThan(shadow.renderOrder)
    expect(rear.renderOrder).toBeLessThan(backing.renderOrder)
    expect(front.renderOrder).toBeGreaterThan(0)
    expect(front.geometry).toBe(rear.geometry)
    expect(front.material.uniforms.hemisphere.value).toBe(1)
    expect(rear.material.uniforms.hemisphere.value).toBe(-1)
    expect(front.material.uniforms.time).toBe(rear.material.uniforms.time)
    expect(front.material.fragmentShader).toContain('arcDepth*hemisphere')
    expect(front.material.fragmentShader).toContain('discard')
    expect(front.material.vertexShader).toContain('arcDepth=p.z')
    expect(front.frustumCulled).toBe(false)
    let exposedRear = 0, occludedRear = 0, foreground = 0
    for (let i = 0; i < 256; i++) {
      const [x,y,z] = ribbonPosition(i, 12, 0, .85, 1, 0)
      const projectedRadius = Math.hypot(x,y) * 5.1 / (5.1-z)
      if (z < 0) { if (projectedRadius > 1) exposedRear++; else occludedRear++ }
      else foreground++
    }
    expect(exposedRear).toBeGreaterThan(10)
    expect(occludedRear).toBeGreaterThan(10)
    expect(foreground).toBeGreaterThan(100)
    front.geometry.dispose(); front.material.dispose(); rear.material.dispose()
    for (const layer of [backing, shadow]) { layer.material.map!.dispose(); layer.geometry.dispose(); layer.material.dispose() }
  })
  it('keeps animated active fabric within the perspective viewport without a flat cutoff', () => {
    const halfFov = 37 * Math.PI / 360
    for (let time = 0; time < 12; time += .5) for (let band = 0; band < 3; band++) {
      for (let column = 0; column < 256; column += 4) for (const row of [0,23]) {
        const [x,y,z] = ribbonPosition(column, row, band, .85, 1.09, time, 1)
        const edge = (5.1-z) * Math.tan(halfFov)
        expect(Math.abs(x) / edge).toBeLessThan(.96)
        expect(Math.abs(y) / edge).toBeLessThan(.96)
      }
    }
  })
  it('expands the outer radius with activity while remaining inside the native viewport', () => {
    const idle = ribbonPosition(0, 12, 0, .25, .55, 0)
    const active = ribbonPosition(0, 12, 0, .85, 1, 0)
    expect(active[0] - idle[0]).toBeGreaterThan(.06)
    for (let band = 0; band < 3; band++) for (let i = 0; i < 256; i++) {
      const p = ribbonPosition(i, 23, band, .85, 1, 0, 1)
      expect(Math.abs(p[0])).toBeLessThan(1.6)
      expect(Math.abs(p[1])).toBeLessThan(1.6)
    }
  })
  it('keeps the approved maximum fabric pulse within the viewport, including point diameter', () => {
    const {front,rear}=createRibbonFabric(0)
    expect(front.material.vertexShader).toContain('p*=.97*(1.+pulse);p.y*=.92;')
    // Settled speaking at fake level 1: largest activity envelope and strength.
    const envelope=.97*(1+.115), halfFov=37*Math.PI/360
    for(let time=0;time<12;time+=.25) for(let band=0;band<3;band++) {
      for(let column=0;column<256;column+=4) for(const row of [0,23]) {
        const raw=ribbonPosition(column,row,band,.85,1.32,time,1)
        const [x,y,z]=[raw[0]*envelope,raw[1]*envelope*.92,raw[2]*envelope]
        const viewport=(5.1-z)*Math.tan(halfFov)
        // 2.3px maximum point diameter; center must leave a half-point margin.
        expect(Math.abs(x)/viewport+1.15/160).toBeLessThan(1)
        expect(Math.abs(y)/viewport+1.15/160).toBeLessThan(1)
      }
    }
    front.geometry.dispose();front.material.dispose();rear.material.dispose()
  })
  it('keeps adjacent dots on ordered, continuous wave rows rather than a scattered cloud', () => {
    const geometry = ribbonGeometry(0)
    const positions = geometry.getAttribute('position')
    expect(positions.count).toBe(256 * 24)
    const a = ribbonPosition(0, 0, 0, 0.6, 0.45, 0)
    const adjacent = ribbonPosition(1, 0, 0, 0.6, 0.45, 0)
    const across = ribbonPosition(0, 1, 0, 0.6, 0.45, 0)
    expect(Math.hypot(...a.map((v, i) => v - adjacent[i]))).toBeLessThan(0.09)
    expect(Math.hypot(...a.map((v, i) => v - across[i]))).toBeLessThan(0.08)
    for (let i = 0; i < 256; i++) {
      const center = ribbonPosition(i, 12, 0, 0.85, 0.7, 1)
      // Clearance is from the sphere origin, not an un-tilted Y-axis cylinder.
      expect(Math.hypot(...center)).toBeGreaterThan(1)
      expect(Math.abs(center[1])).toBeLessThan(1.1)
    }
    geometry.dispose()
  })
  it('reacts to audio without breaking the fabric order or crossing the globe center', () => {
    for (let band = 0; band < 3; band++) {
      const quiet = ribbonPosition(40, 12, band, 0.7, 0.85, 1, 0)
      const loud = ribbonPosition(40, 12, band, 0.7, 0.85, 1, 1)
      expect(loud).not.toEqual(quiet)
      expect(Math.hypot(...loud)).toBeGreaterThan(1)
      expect(Math.hypot(...quiet.map((v, i) => v - loud[i]))).toBeLessThan(0.2)
    }
  })
  it('forms separated upper and lower wave arcs instead of compact side clouds', () => {
    const top = ribbonPosition(64, 12, 0, .85, .7, 0)
    const bottom = ribbonPosition(192, 12, 0, .85, .7, 0)
    expect(top[1]).toBeGreaterThan(.75)
    expect(bottom[1]).toBeLessThan(-.75)
  })
})