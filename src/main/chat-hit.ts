import { orbHit } from './window-hit'
import type { Point } from './window-position'
export interface HitRect { x: number; y: number; width: number; height: number }
export interface ChatHitGeometry { controls: HitRect; captions: HitRect; input: HitRect; menu: HitRect }
const defaults: ChatHitGeometry = { controls: { x: 8, y: 265, width: 304, height: 83 }, captions: { x: 16, y: 360, width: 288, height: 104 }, input: { x: 16, y: 474, width: 288, height: 38 }, menu: { x: 0, y: 0, width: 0, height: 0 } }
function contains(r: HitRect, x: number, y: number) { return r.width > 0 && r.height > 0 && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height }
export function validGeometry(value: unknown): value is ChatHitGeometry {
  if (!value || typeof value !== 'object') return false
  const g = value as ChatHitGeometry
  return ['controls','captions','input','menu'].every(key => {
    const r = g[key as keyof ChatHitGeometry]
    return !!r && [r.x,r.y,r.width,r.height].every(n => Number.isFinite(n) && n >= 0 && n <= 520) && r.x + r.width <= 320 && r.y + r.height <= 520
  })
}
export function chatHit(cursor: Point, bounds: Point, input: boolean, captions: boolean, chrome = true, geometry: ChatHitGeometry = defaults) {
  const x = cursor.x - bounds.x, y = cursor.y - bounds.y
  return orbHit(cursor, bounds) || (chrome && (contains(geometry.controls,x,y) || contains(geometry.menu,x,y)
    || captions && contains(geometry.captions,x,y) || input && contains(geometry.input,x,y)))
}
