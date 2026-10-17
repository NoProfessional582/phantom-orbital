const ROUTINE_VOICE_NOTICES = new Set([
  'Voice filter ready.',
  'Speaker filter off.',
  'Preparing local wake listener…',
  'Capturing command…',
  'Verifying voice / transcribing locally…',
  'Activation paused — mic closed'
])

export function isRoutineVoiceNotice(notice: string): boolean {
  const text = notice.trim()
  return ROUTINE_VOICE_NOTICES.has(text) || /^Listening for [A-Za-z' -]+$/.test(text)
}
