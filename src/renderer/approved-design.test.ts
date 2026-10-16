import * as THREE from 'three'
import { afterEach, expect, it, vi } from 'vitest'
import { createOrb } from './orb'
import { STATES, target, type OrbState } from './state'

// Only the browser/WebGL boundary is mocked. Real scene construction, clocks,
// springs and tick updates run, so assertions cover what actually reaches a draw.
const draw = vi.hoisted(() => ({ scene: undefined as THREE.Scene | undefined }))
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof THREE>()
  return { ...actual, WebGLRenderer: class {
    domElement = { remove() {} }
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    render(scene: THREE.Scene) { draw.scene = scene }
    dispose() {}
  } }
})
let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); dispose=undefined; vi.unstubAllGlobals() })

function fixture(state: OrbState, level = 0) {
  let callback: FrameRequestCallback = () => {}, now = 0
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  vi.stubGlobal('performance', { now: () => now })
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { callback=fn; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const host = { clientWidth:320, clientHeight:320, appendChild() {} } as unknown as HTMLElement
  const orb=createOrb(host,{initial:state,level});dispose=orb.dispose
  const advance=(frames: number) => { for(let i=0;i<frames;i++) { now+=1000/60; callback(now) } }
  advance(1)
  const scene=draw.scene!
  const globe=scene.children.find(o=>o instanceof THREE.Group && o.children.some(c=>c instanceof THREE.Mesh && c.geometry instanceof THREE.SphereGeometry && c.geometry.parameters.radius===.14))!
  const core=globe.children.find(c=>c instanceof THREE.Mesh && c.geometry instanceof THREE.SphereGeometry && c.geometry.parameters.radius===.14) as THREE.Mesh<THREE.SphereGeometry,THREE.ShaderMaterial>
  const halo=scene.children.find(o=>o instanceof THREE.Mesh && o.geometry instanceof THREE.PlaneGeometry && o.geometry.parameters.width===2.5) as THREE.Mesh<THREE.PlaneGeometry,THREE.ShaderMaterial>
  const rings=scene.children.filter(o=>o instanceof THREE.Group && o!==globe) as THREE.Group[]
  const fabric=scene.children.filter(o=>o instanceof THREE.Points && o.material instanceof THREE.ShaderMaterial && o.material.uniforms.hemisphere) as THREE.Points<THREE.BufferGeometry,THREE.ShaderMaterial>[]
  const stars=globe.children.find(o=>o instanceof THREE.Points) as THREE.Points<THREE.BufferGeometry,THREE.ShaderMaterial>
  const backing=scene.children.find(o=>o.renderOrder===-3)!,shadow=scene.children.find(o=>o.renderOrder===-4)!
  const ringMaterial=rings[0].children[0] as THREE.Mesh<THREE.BufferGeometry,THREE.ShaderMaterial>
  return {orb,advance,scene,globe,core,halo,rings,fabric,stars,backing,shadow,ringMaterial}
}

it('draws constant connected orbital rates with stationary independently flowing fabric, never pausing when idle', () => {
  for(const state of STATES.filter(s => s !== 'offline')) {
    const f=fixture(state)
    const before={spin:f.globe.rotation.y,orbit:f.rings[0].rotation.y,highlight:f.ringMaterial.material.uniforms.time.value,wave:f.fabric[0].material.uniforms.time.value,bodyTime:f.stars.material.uniforms.time.value}
    f.advance(240)
    const rate=1
    // Idle draws at 30Hz: the final RAF may not yet be a due draw. Use the
    // actual integrated body clock, not wall time since an unrendered frame.
    const elapsed=(f.stars.material.uniforms.time.value-before.bodyTime)/2
    expect(elapsed).toBeGreaterThan(3.96)
    expect(elapsed).toBeLessThanOrEqual(4.001)
    expect(f.globe.rotation.y-before.spin).toBeCloseTo(.4*elapsed*rate,6)
    expect(f.rings[0].rotation.y-before.orbit).toBeCloseTo(-2.4*elapsed*rate,6)
    expect(f.ringMaterial.material.uniforms.time.value-before.highlight).toBeCloseTo(-.135*elapsed*rate,6)
    expect(f.fabric[0].material.uniforms.time.value-before.wave).toBeCloseTo((.5+target(state).ribbonSpeed)*3*elapsed,6)
    for(const fabric of f.fabric) {
      expect(fabric.rotation.toArray().slice(0,3)).toEqual([0,0,0])
      expect(fabric.position.toArray()).toEqual([0,0,0])
    }
    f.orb.dispose()
  }
})

it('offline (no backend) slows, then freezes once its transition settles', () => {
  const f=fixture('offline')
  const before={spin:f.globe.rotation.y,bodyTime:f.stars.material.uniforms.time.value}
  f.advance(240)
  const frozenSpin=f.globe.rotation.y, frozenBody=f.stars.material.uniforms.time.value
  const elapsed=(frozenBody-before.bodyTime)/2
  expect(elapsed).toBeGreaterThan(1.9)
  expect(elapsed).toBeLessThan(2.1)
  expect(frozenSpin-before.spin).toBeCloseTo(.4*elapsed*.5,6)
  f.advance(240)
  expect(f.globe.rotation.y).toBe(frozenSpin)
  f.orb.dispose()
})

it('pulses only the centered nucleus and halo on the four-second activity clock including approval', () => {
  for(const state of ['listening','thinking','working','speaking','approval'] as const) {
    const f=fixture(state)
    f.advance(119) // two seconds
    const crest=f.core.scale.x, strength=f.core.material.uniforms.strength.value
    expect(crest).toBeCloseTo(1+.24*1.6,6)
    expect(strength).toBeCloseTo(target(state).core*(1+.24*1.2),6)
    expect(f.halo.scale.x).toBeCloseTo(target(state).scale*(1+.24*.8),6)
    f.advance(120)
    expect(f.core.scale.x).toBeCloseTo(1,6)
    expect(f.core.material.uniforms.strength.value).toBeCloseTo(target(state).core,6)
    f.advance(120)
    expect(f.core.scale.x).toBeCloseTo(crest,6)
    expect(f.core.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([0,0,0])
    f.orb.dispose()
  }
})

it('never breathes body, grid, backing or shadow while active nucleus and fabric pulse', () => {
  for(const state of STATES) {
    const f=fixture(state), scale=target(state).scale
    for(let frame=0;frame<300;frame++) {
      f.advance(1)
      expect(f.globe.scale.toArray()).toEqual([scale,scale,scale])
      expect(f.backing.scale.toArray()).toEqual([scale,scale,scale])
      expect(f.shadow.scale.x).toBeCloseTo(1.18*scale)
      expect(f.rings.every(r=>r.scale.x===scale)).toBe(true)
      if(['idle','transcribing','muted','offline'].includes(state)) {
        expect(f.core.scale.x).toBe(1)
        expect(f.fabric[0].material.uniforms.pulse.value).toBe(0)
        expect(f.fabric[0].material.uniforms.strength.value).toBe(target(state).ribbon)
      }
    }
    f.orb.dispose()
  }
})

it('keeps ribbon pulse separate, larger and faster with activity and accepted fake audio', () => {
  const measure=(state: OrbState,level: number) => {
    const f=fixture(state,level), pulses: number[]=[], strengths: number[]=[]
    for(let i=0;i<600;i++) { f.advance(1);pulses.push(f.fabric[0].material.uniforms.pulse.value);strengths.push(f.fabric[0].material.uniforms.strength.value) }
    const peaks=pulses.filter((p,i)=>i>0 && i<pulses.length-1 && p>pulses[i-1] && p>=pulses[i+1]).length
    const result={max:Math.max(...pulses),peaks,strength:Math.max(...strengths)-target(state).ribbon}
    f.orb.dispose();return result
  }
  const listening=measure('listening',0),working=measure('working',0),speaking=measure('speaking',1)
  expect(working.max).toBeGreaterThan(listening.max)
  expect(working.peaks).toBeGreaterThan(listening.peaks)
  expect(speaking.max).toBeGreaterThan(working.max)
  expect(speaking.peaks).toBeGreaterThan(working.peaks)
  expect(speaking.max).toBeCloseTo(.115,3)
  expect(speaking.strength).toBeCloseTo(.32,3)
  expect(speaking.peaks).toBeGreaterThan(10) // independent of the 4s star clock
})

it('retains two blue bands and one yellow band, shared front/rear uniforms, and no offline fabric', () => {
  const f=fixture('idle')
  const front=f.fabric.filter(o=>o.material.uniforms.hemisphere.value===1)
  expect(front.map(o=>o.material.uniforms.warm.value)).toEqual([0,1,0])
  for(const band of front) {
    expect(band.material.uniforms.blue.value.toArray()).toEqual([.055,.43,.88])
    expect(band.material.uniforms.orange.value.toArray()).toEqual([1,.68,.025])
    const rear=f.fabric.find(o=>o.geometry===band.geometry && o!==band)!
    expect(rear.material.uniforms.pulse).toBe(band.material.uniforms.pulse)
    expect(rear.material.uniforms.strength).toBe(band.material.uniforms.strength)
  }
  expect(f.fabric.filter(o=>o.visible)).toHaveLength(6)
  f.orb.setState('offline');f.advance(3)
  expect(f.fabric.filter(o=>o.visible)).toHaveLength(0)
  f.orb.setState('idle');f.advance(3)
  expect(f.fabric.filter(o=>o.visible)).toHaveLength(6)
})

it('keeps muted galaxy at idle brightness and offline at the old muted blue values', () => {
  for(const state of ['idle','muted','offline'] as const) {
    const f=fixture(state),offline=state==='offline'
    f.advance(240)
    expect(f.core.material.uniforms.strength.value).toBe(offline?.30:.85)
    expect(f.core.material.uniforms.saturation.value).toBe(offline?.60:1)
    expect(f.core.material.uniforms.brightness.value).toBe(offline?2.1:2.5)
    expect(f.core.material.uniforms.whiteness.value).toBe(offline?0:1)
    expect(f.halo.material.uniforms.strength.value).toBeCloseTo(offline?.165:.4675)
    expect(f.halo.material.uniforms.brightness.value).toBe(offline?1.65:1.85)
    expect(f.stars.material.uniforms.strength.value).toBe(offline?.30:.85)
    expect(f.stars.material.uniforms.saturation.value).toBe(offline?.60:1)
    f.orb.dispose()
  }
})

it('draws triangle-expanded 2px grid and 2.1px rings while glass and shadow do not compound interior opacity', () => {
  const f=fixture('idle')
  const grid=f.globe.children.find(o=>o instanceof THREE.Mesh && o.material instanceof THREE.ShaderMaterial && o.material.uniforms.strokeWidth) as THREE.Mesh<THREE.BufferGeometry,THREE.ShaderMaterial>
  expect(grid.material.uniforms.strokeWidth.value).toBe(2)
  for(const ring of f.rings) {
    const mesh=ring.children[0] as THREE.Mesh<THREE.BufferGeometry,THREE.ShaderMaterial>
    expect(mesh.material.uniforms.strokeWidth.value).toBe(2.1)
    expect(mesh.geometry.index!.count).toBe(256*6)
    expect(mesh.geometry.getAttribute('edge').count).toBe(256*4)
  }
  const backing=f.backing as THREE.Mesh<THREE.PlaneGeometry,THREE.MeshBasicMaterial>
  const shadow=f.shadow as THREE.Mesh<THREE.PlaneGeometry,THREE.MeshBasicMaterial>
  const center=(256/2*256+256/2)*4+3
  expect(backing.material.map!.image.data[center]).toBe(191)
  expect(shadow.material.map!.image.data[center]).toBe(0)
  const glass=f.globe.children.find(o=>o.renderOrder===-2) as THREE.Mesh<THREE.BufferGeometry,THREE.ShaderMaterial>
  expect(glass.material.fragmentShader).toContain('.15*rim')
  expect(glass.material.fragmentShader).toContain('pow(1.-max(dot(normalize(n),normalize(v)),0.),3.)')
  expect(f.scene.children.filter((o): o is THREE.Mesh<THREE.PlaneGeometry>=>o instanceof THREE.Mesh && o.geometry instanceof THREE.PlaneGeometry).map(o=>o.geometry.parameters.height).sort()).toEqual([2,2.24,2.5])
})
