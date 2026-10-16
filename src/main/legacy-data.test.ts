import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrateLegacyData } from './legacy-data'

test('copies the voice enrollment and window position once, never overwriting or deleting', () => {
  const appData = mkdtempSync(join(tmpdir(), 'orb-legacy-'))
  try {
    const legacy = join(appData, 'hermes-orb'), next = join(appData, 'phantom-orbital')
    mkdirSync(join(legacy, 'voice-profiles'), { recursive: true })
    writeFileSync(join(legacy, 'voice-profiles', 'registered.json'), '{"synthetic":1}')
    writeFileSync(join(legacy, 'positions.json'), '{"x":1}')
    expect(migrateLegacyData(appData, next).sort()).toEqual([join('voice-profiles', 'registered.json'), 'positions.json'].sort())
    expect(readFileSync(join(next, 'voice-profiles', 'registered.json'), 'utf8')).toBe('{"synthetic":1}')
    writeFileSync(join(next, 'positions.json'), '{"x":2}')
    expect(migrateLegacyData(appData, next)).toEqual([])
    expect(readFileSync(join(next, 'positions.json'), 'utf8')).toBe('{"x":2}')
    expect(readFileSync(join(legacy, 'positions.json'), 'utf8')).toBe('{"x":1}')
  } finally { rmSync(appData, { recursive: true, force: true }) }
})

test('does nothing without a legacy folder', () => {
  const appData = mkdtempSync(join(tmpdir(), 'orb-legacy-'))
  try { expect(migrateLegacyData(appData, join(appData, 'phantom-orbital'))).toEqual([]) }
  finally { rmSync(appData, { recursive: true, force: true }) }
})
