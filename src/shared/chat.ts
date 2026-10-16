export interface ChatSnapshot {
  inputOrigin?: 'text' | 'voice'
  transcriptDismissed?: boolean
  speech?: { id: string; text: string; phase: 'stream' | 'interim' | 'complete' | 'failed' }
  synthetic?: boolean
  syntheticAudio?: boolean
  approval?: { id: string; action: string; pending: boolean }
  approvalShortcutAvailable?: boolean
  assistant?: { name: string; wakePhrase: string; user: string }
  reminders?: { id: string; title: string; message: string; url: string }[]
  voice?: import('./voice').VoiceSnapshot
  state: 'idle' | 'thinking' | 'working' | 'offline' | 'approval'
  user: string
  answer: string
  notice: string
  busy: boolean
  stopping: boolean
  inputOpen: boolean
}
