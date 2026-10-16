import * as THREE from 'three'

const columns = 256, rows = 24

// Each segment is a pair of triangles, expanded in clip space by the shader.
// Width is measured in CSS pixels, not driver-dependent WebGL line primitives.
export const strokeVertex = `attribute vec3 start,end;attribute float edge;
  uniform vec2 resolution;uniform float strokeWidth;varying vec2 vUv;varying float facing;
  void main(){vUv=uv;vec4 mv=modelViewMatrix*vec4(position,1.);
    facing=dot(normalize(normalMatrix*position),normalize(-mv.xyz));
    vec4 a=projectionMatrix*modelViewMatrix*vec4(start,1.);
    vec4 b=projectionMatrix*modelViewMatrix*vec4(end,1.);
    vec2 delta=(b.xy/b.w-a.xy/a.w)*resolution;
    vec2 direction=delta/max(length(delta),.0001);
    vec4 clip=projectionMatrix*mv;
    clip.xy+=vec2(-direction.y,direction.x)*edge*strokeWidth/resolution*clip.w;
    gl_Position=clip;}`

export function strokeGeometry(segments: ArrayLike<number>, phases?: ArrayLike<number>): THREE.BufferGeometry {
  const position: number[] = [], start: number[] = [], end: number[] = [], edge: number[] = [], uv: number[] = [], indices: number[] = []
  for (let i = 0; i < segments.length; i += 6) {
    const a = [segments[i],segments[i+1],segments[i+2]], b = [segments[i+3],segments[i+4],segments[i+5]], k = position.length/3
    for (let vertex = 0; vertex < 4; vertex++) {
      position.push(...(vertex < 2 ? a : b));start.push(...a);end.push(...b)
      edge.push(vertex%2 === 0 ? -1 : 1)
      uv.push(phases?.[i/3+(vertex < 2 ? 0 : 1)] ?? (vertex < 2 ? 0 : 1),vertex%2)
    }
    indices.push(k,k+1,k+2,k+1,k+3,k+2)
  }
  const geometry = new THREE.BufferGeometry()
  for (const [name,data,size] of [['position',position,3],['start',start,3],['end',end,3],['edge',edge,1],['uv',uv,2]] as const)
    geometry.setAttribute(name,new THREE.Float32BufferAttribute(data,size))
  geometry.setIndex(indices)
  return geometry
}

export function ringGeometry(band: number): THREE.BufferGeometry {
  const radius = band === 2 ? 1.22 : 1.28, segments: number[] = [], phases: number[] = []
  for (let i = 0; i < columns; i++) {
    for (const t of [i/columns,(i+1)/columns]) {
      const a = t*Math.PI*2
      segments.push(radius*Math.cos(a),radius*Math.sin(a),0);phases.push(t)
    }
  }
  return strokeGeometry(segments,phases)
}

export function ribbonBasePosition(column: number, band: number, spread: number): [number, number, number] {
  const a = column / columns * Math.PI * 2, radius = 1.13 + spread * .14 + band * .045
  return [Math.cos(a)*radius, Math.sin(a)*radius*Math.sin(.7), Math.sin(a)*radius*Math.cos(.7)]
}

/** The same continuous toroidal wave used by the ribbon vertex shader. */
export function ribbonPosition(column: number, row: number, band: number, spread: number, strength: number, time: number, audio = 0): [number, number, number] {
  const a = column / columns * Math.PI * 2, v = row / (rows - 1) * 2 - 1
  const wave = Math.sin(a * 5 + time * .7 + band * .75 + v * .8) * (.045 + strength * .11 + audio * .045)
    + Math.sin(a * 3 - time * .35 + band * .95) * .035
  // Even radial harmonics preserve opposite radii; odd height harmonics have no drift.
  const radial = Math.sin(a * 4 + time * .7 + band * .75 + v * .8) * (.045 + strength * .11 + audio * .045)
    + Math.sin(a * 6 - time * .35 + band * .95) * .035
  const base = ribbonBasePosition(column, band, spread)
  const radius = Math.hypot(...base) + radial * .4 + v * .035
  const x=Math.cos(a)*radius, y=v*(.1+spread*.12)*.8+wave*.8+Math.sin(a)*radius*Math.sin(.7), z=Math.sin(a)*radius*Math.cos(.7)
  return [x,y,z]
}

export function ribbonGeometry(band: number): THREE.BufferGeometry {
  const positions = new Float32Array(columns * rows * 3)
  const seeds = new Float32Array(columns * rows)
  for (let column = 0; column < columns; column++) for (let row = 0; row < rows; row++) {
    const index = column * rows + row
    positions.set([column / columns * Math.PI * 2, row / (rows - 1) * 2 - 1, band], index * 3)
    seeds[index] = ((index * 19 + band * 37) % 101) / 101
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 1))
  return geometry
}
