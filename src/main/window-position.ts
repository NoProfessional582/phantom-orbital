export interface Point { x: number; y: number }
export function dragPosition(windowStart: Point, pointerStart: Point, pointerNow: Point): Point {
  return { x: Math.round(windowStart.x + pointerNow.x - pointerStart.x), y: Math.round(windowStart.y + pointerNow.y - pointerStart.y) }
}
