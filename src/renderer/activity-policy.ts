export const IDLE_DELAY_MS = 3000

export class ActivityVisibility {
  visible = false
  pinned = false
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly changed: (visible: boolean) => void) {}
  reveal() {
    this.setVisible(true)
    this.scheduleHide()
  }
  setPinned(pinned: boolean) {
    if (this.pinned === pinned) return
    this.pinned = pinned
    if (pinned) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      this.setVisible(true)
    } else this.scheduleHide()
  }
  private scheduleHide() {
    if (this.pinned) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; this.setVisible(false) }, IDLE_DELAY_MS)
  }
  private setVisible(value: boolean) {
    if (this.visible === value) return
    this.visible = value
    this.changed(value)
  }
  dispose() { if (this.timer) clearTimeout(this.timer) }
}

export function shouldRevealForSnapshot(snapshot: { busy: boolean; stopping: boolean; approval?: unknown; voice?: { state?: string; followupActive?: boolean; speechActive?: boolean; enrolling?: boolean } }): boolean {
  return snapshot.busy || snapshot.stopping || !!snapshot.approval || !!snapshot.voice?.followupActive || !!snapshot.voice?.speechActive || !!snapshot.voice?.enrolling || ['capturing', 'listening', 'followup', 'transcribing', 'verifying', 'speaking', 'error'].includes(snapshot.voice?.state || '')
}
