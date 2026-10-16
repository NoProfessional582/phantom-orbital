/** Accumulate deadlines so high-refresh desktops retain the requested cadence. */
export class FrameClock {
  private next = 0
  due(now: number, fps: number): boolean {
    if (now + .001 < this.next) return false
    const interval = 1000 / fps
    this.next = (now - this.next > interval ? now : this.next) + interval
    return true
  }
}

/** Visual phases only. Physics, audio smoothing and deadlines use real dt. */
export class VisualClock {
  body = 0
  spin = 0
  fabric = 0
  rings = 0
  orbit = 0 // Thin rings only; fabric wave time never rotates its placement.
  step(dt: number, ringSpeed: number, spinSpeed: number, ribbonSpeed = ringSpeed) {
    this.body += dt * 2
    this.spin += dt * spinSpeed * 2
    this.fabric += dt * (.5 + ribbonSpeed) * 3
    this.rings -= dt * ringSpeed * .15 * 3
    this.orbit -= dt * (.5 + ringSpeed) * 3
  }
}
