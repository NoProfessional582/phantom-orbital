import type { ChatSnapshot } from '../shared/chat'

export interface TranscriptTurn { id: string; prompt: string; reply: string }
export interface TranscriptUpdate { added: boolean; reset: boolean }

export class TranscriptHistory {
  readonly turns: TranscriptTurn[] = []
  private readonly retiredIds = new Set<string>()

  private clearTurns() {
    for (const turn of this.turns) this.retiredIds.add(turn.id)
    this.turns.length = 0
  }

  apply(snapshot: ChatSnapshot): TranscriptUpdate {
    const id = snapshot.speech?.id
    if (!id) {
      const reset = this.turns.length > 0 && !snapshot.user.trim() && !snapshot.answer && !snapshot.busy && !snapshot.approval
      if (reset) this.clearTurns()
      return { added: false, reset }
    }
    if (this.retiredIds.has(id)) return { added: false, reset: false }
    let turn = this.turns.find(item => item.id === id)
    if (!turn) {
      if (!snapshot.user.trim()) return { added: false, reset: false }
      turn = { id, prompt: snapshot.user, reply: snapshot.answer }
      this.turns.push(turn)
      return { added: true, reset: false }
    }
    if (snapshot.user.trim()) turn.prompt = snapshot.user
    turn.reply = snapshot.answer
    return { added: false, reset: false }
  }

  dismiss() { this.clearTurns() }
}

export function nearTranscriptBottom(scrollHeight: number, scrollTop: number, clientHeight: number, threshold = 32) {
  return scrollHeight - scrollTop - clientHeight <= threshold
}
