import * as THREE from 'three'

export const PALETTE = { blue: '#0078d4', ink: '#102e62', orange: '#f58220', gold: '#ffca45' } as const

/** Fixed-size spiral arms plus a diffuse spherical halo; no runtime allocation. */
export function galaxyGeometry(): THREE.BufferGeometry {
  const count = 720, positions = new Float32Array(count * 3), sizes = new Float32Array(count), seeds = new Float32Array(count)
  const noise = (i: number, salt: number) => ((i * salt + 97) % 997) / 997
  for (let i = 0; i < count; i++) {
    const r = .08 + Math.sqrt(noise(i, 137)) * .8
    const angle = i % 3 * Math.PI * 2 / 3 + r * 7 + (noise(i, 317) - .5) * .7
    const halo = i % 4 === 0
    const x = Math.cos(angle) * r, y = Math.sin(angle) * r
    positions.set(halo
      ? [x * .8, y * .7, (noise(i, 541) - .5) * .85]
      : [x, y * .55 + (noise(i, 541) - .5) * .1, y * .35 + (noise(i, 433) - .5) * .25], i * 3)
    sizes[i] = i % 29 === 0 ? 4.8 : .9 + noise(i, 619) * 1.7
    seeds[i] = noise(i, 733)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1))
  geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 1))
  return geometry
}
