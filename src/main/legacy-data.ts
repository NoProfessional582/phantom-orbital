import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The app was renamed from "hermes-orb". Carry the voice enrollment and window
// position over once, so nobody has to re-enroll. The old folder is left alone.
export const LEGACY_DATA_DIR = 'hermes-orb'
const CARRIED = [join('voice-profiles', 'registered.json'), 'positions.json']

export function migrateLegacyData(appData: string, userData: string): string[] {
  const legacy = join(appData, LEGACY_DATA_DIR)
  if (legacy === userData || !existsSync(legacy)) return []
  const copied: string[] = []
  for (const name of CARRIED) {
    const from = join(legacy, name), to = join(userData, name)
    if (!existsSync(from) || existsSync(to)) continue
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    copied.push(name)
  }
  return copied
}
