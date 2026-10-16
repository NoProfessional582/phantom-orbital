import type { ChatSnapshot } from '../shared/chat'

// Identity comparison, never a renderer-provided role, URL or claimed user gesture.
export function trustedControl(event: { sender: unknown; senderFrame: unknown }, contents: { mainFrame: unknown } | null | undefined, locked: boolean) {
  return !locked && !!contents && event.sender === contents && event.senderFrame === contents.mainFrame
}
export function canApproveHotkey(card: ChatSnapshot['approval'], visible: boolean, focused: boolean, locked: boolean, id: unknown) {
  return !!card && card.id === id && !card.pending && visible && focused && !locked
}
