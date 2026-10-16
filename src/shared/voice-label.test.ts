import { expect, test } from 'vitest'
import { nextVoiceMode, voiceModeDescription, voiceModeLabel } from './voice'

test('visible labels map internal states to Off, PTT, Voice without changing behavior', () => {
  expect(['off', 'voice', 'active'].map(voiceModeLabel)).toEqual(['Off', 'PTT', 'Voice'])
  expect(['off', 'voice', 'active'].map(mode => voiceModeLabel(nextVoiceMode(mode as 'off' | 'voice' | 'active')))).toEqual(['PTT', 'Voice', 'Off'])
  expect(voiceModeDescription('off')).toMatch(/capture.*off/i)
  expect(voiceModeDescription('voice')).toMatch(/push.to.talk.*five.second.*no idle wake/i)
  expect(voiceModeDescription('active')).toMatch(/push.to.talk.*Hey Megan/i)
})
