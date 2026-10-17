export type VoiceMode = 'off' | 'voice' | 'active'
export function validVoiceMode(value: unknown): value is VoiceMode { return value === 'off' || value === 'voice' || value === 'active' }
export function nextVoiceMode(mode: VoiceMode): VoiceMode { return mode === 'off' ? 'voice' : mode === 'voice' ? 'active' : 'off' }
const voiceModeLabels: Record<VoiceMode, string> = { off: 'Off', voice: 'PTT', active: 'Voice' }
const voiceModeDescriptions: Record<VoiceMode, string> = {
  off: 'Voice and audio capture are off.',
  voice: 'Push-to-talk, local spoken replies, and five-second follow-up; no idle wake listening.',
  active: 'Push-to-talk and local spoken replies, plus {wake} wake activation.'
}
export function voiceModeLabel(mode: VoiceMode): string { return voiceModeLabels[mode] }
export function voiceModeDescription(mode: VoiceMode, wakePhrase = 'Hey Megan'): string { return voiceModeDescriptions[mode].replace('{wake}', wakePhrase) }
export interface VoiceSnapshot {
  mode?: VoiceMode
  nextMode?: VoiceMode
  pendingMode?: VoiceMode
  enabled: boolean
  ready: boolean
  muted: boolean
  state: 'idle' | 'listening' | 'followup' | 'transcribing' | 'speaking' | 'muted' | 'error' | 'arming' | 'armed' | 'capturing' | 'verifying'
  activation?: boolean
  level: number
  notice: string
  device: string
  hotkeyAvailable: boolean
  muteShortcutAvailable: boolean
  registered?: boolean
  speakerFilter?: boolean
  speechActive?: boolean
  followupActive?: boolean
  enrolling?: boolean
  enrollmentCount?: number
}
