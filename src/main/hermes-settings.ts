import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
export function apiKeyFromEnv(text: string): string {
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?API_SERVER_KEY\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const value = match[1].trim()
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(value)
    const key = quoted ? quoted[2] : value.split(/\s+#/)[0].trim()
    if (key && !/[\r\n]/.test(key)) return key
  }
  throw new Error('Missing API_SERVER_KEY')
}
export interface HermesOptions { home?: string; profile?: string; endpoint?: string }
/**
 * Hermes API server credentials. With a profile, Orb reads only that profile's
 * .env and talks only to its /p/<profile> route; it never falls back to the
 * default profile's key. Without a profile it uses the Hermes home .env.
 */
export function hermesSettings(options: HermesOptions = {}, env: NodeJS.ProcessEnv = process.env) {
  const profile = options.profile
  const home = resolve(options.home || env.HERMES_HOME || join(env.LOCALAPPDATA || join(env.USERPROFILE || '.', 'AppData', 'Local'), 'hermes'))
  const keyHome = !profile ? home
    : basename(dirname(home)) === 'profiles' && basename(home) === profile ? home : join(home, 'profiles', profile)
  const route = profile ? `/p/${profile}` : ''
  const endpoint = env.ORB_HERMES_ENDPOINT || options.endpoint || `http://127.0.0.1:8642${route}`
  const invalid = `Hermes endpoint must use loopback HTTP${route ? ' ' + route : ''}`
  let url: URL
  try { url = new URL(endpoint) } catch { throw new Error(invalid) }
  const path = url.pathname.replace(/\/$/, '')
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || path !== route) throw new Error(invalid)
  try { return { endpoint, key: apiKeyFromEnv(readFileSync(join(keyHome, '.env'), 'utf8')) } }
  catch { throw new Error(`Hermes API key unavailable in ${profile ? `the ${profile} profile` : 'the Hermes home'}`) }
}
