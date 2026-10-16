import { describe, expect, it } from 'vitest'
import { isRoutineVoiceNotice } from './voice-notice'

describe('routine voice notice presentation', () => {
  it.each([
    'Voice filter ready.',
    'Listening for Hey Megan',
    'Preparing local wake listener…',
    'Capturing command…',
    'Verifying voice / transcribing locally…',
    'Activation paused — mic closed'
  ])('suppresses routine status %s', notice => {
    expect(isRoutineVoiceNotice(notice)).toBe(true)
  })

  it.each([
    'Missing local model. Voice remains off.',
    'Not enrolled. Choose Enroll voice; typed text still works.',
    'Voice rejected. Try again in a quiet room.',
    'Use only your own voice in a quiet room; six samples are required.'
  ])('preserves actionable notice %s', notice => {
    expect(isRoutineVoiceNotice(notice)).toBe(false)
  })
})
