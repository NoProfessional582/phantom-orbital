import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { apiKeyFromEnv, hermesSettings } from './hermes-settings'
test('reads only API_SERVER_KEY from dotenv including quoted values and ignores similarly named entries', () => {
  expect(apiKeyFromEnv('# ignored\nOTHER=not-used\nAPI_SERVER_KEY_EXTRA=wrong\nexport API_SERVER_KEY="synthetic-only" # comment\n')).toBe('synthetic-only')
})
test('missing key throws a generic error without dotenv values', () => {
  expect(() => apiKeyFromEnv('OTHER=private')).toThrow('Missing API_SERVER_KEY')
})

const temp = () => mkdtempSync(join(tmpdir(), 'orb-hermes-test-'))

test('a configured profile reads only its credentials and selects its explicit route', () => {
  const root = temp()
  try {
    const megan = join(root, 'profiles', 'megan')
    mkdirSync(megan, { recursive: true })
    writeFileSync(join(root, '.env'), 'API_SERVER_KEY=synthetic-default')
    writeFileSync(join(megan, '.env'), 'API_SERVER_KEY=synthetic-megan')
    expect(hermesSettings({ profile: 'megan' }, { HERMES_HOME: root })).toEqual({
      endpoint: 'http://127.0.0.1:8642/p/megan', key: 'synthetic-megan'
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('without a profile the Hermes home key and root route are used', () => {
  const root = temp()
  try {
    writeFileSync(join(root, '.env'), 'API_SERVER_KEY=synthetic-default')
    expect(hermesSettings({ home: root }, {})).toEqual({ endpoint: 'http://127.0.0.1:8642', key: 'synthetic-default' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a profile-scoped HERMES_HOME does not append a second profiles directory', () => {
  const root = temp()
  try {
    const megan = join(root, 'profiles', 'megan')
    mkdirSync(megan, { recursive: true })
    writeFileSync(join(megan, '.env'), 'API_SERVER_KEY=synthetic-megan')
    expect(hermesSettings({ profile: 'megan' }, { HERMES_HOME: megan }).key).toBe('synthetic-megan')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an endpoint override cannot route a profile to default or another profile', () => {
  const root = temp()
  try {
    const megan = join(root, 'profiles', 'megan')
    mkdirSync(megan, { recursive: true })
    writeFileSync(join(megan, '.env'), 'API_SERVER_KEY=synthetic-megan')
    for (const endpoint of ['http://127.0.0.1:8642', 'http://127.0.0.1:8642/p/default', 'http://127.0.0.1:8642/p/other']) {
      expect(() => hermesSettings({ profile: 'megan' }, { HERMES_HOME: root, ORB_HERMES_ENDPOINT: endpoint })).toThrow('Hermes endpoint must use loopback HTTP /p/megan')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('missing or empty profile credentials never fall back to a usable default key', () => {
  const root = temp()
  try {
    writeFileSync(join(root, '.env'), 'API_SERVER_KEY=synthetic-default')
    const megan = join(root, 'profiles', 'megan')
    expect(() => hermesSettings({ profile: 'megan' }, { HERMES_HOME: root })).toThrow(/^Hermes API key unavailable in the megan profile$/)
    mkdirSync(megan, { recursive: true })
    writeFileSync(join(megan, '.env'), 'OTHER=synthetic-private\nAPI_SERVER_KEY=')
    expect(() => hermesSettings({ profile: 'megan' }, { HERMES_HOME: root })).toThrow(/^Hermes API key unavailable in the megan profile$/)
    expect(() => hermesSettings({ profile: 'megan' }, { HERMES_HOME: megan })).toThrow(/^Hermes API key unavailable in the megan profile$/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.each(['https://127.0.0.1:8642/p/megan', 'http://example.com/p/megan', 'http://user:password@127.0.0.1:8642/p/megan', 'http://127.0.0.1:8642/p/megan?key=synthetic-only', 'http://127.0.0.1:8642/p/megan#secret', 'not-a-url'])('settings reject unsafe endpoint %s', endpoint => {
  expect(() => hermesSettings({ profile: 'megan' }, { ORB_HERMES_ENDPOINT: endpoint })).toThrow(/^Hermes endpoint must use loopback HTTP \/p\/megan$/)
})
