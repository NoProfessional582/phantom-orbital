import type { Point } from './window-position'

export function orbHit(cursor: Point, bounds: Point): boolean {
  return Math.hypot(cursor.x - bounds.x - 160, cursor.y - bounds.y - 151) < 125 * .95
}
