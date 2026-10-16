import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadConfig, personalityPrompt } from './orb-config'

function project(files: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'orb-config-test-'))
  for (const [name, value] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), typeof value === 'string' ? value : JSON.stringify(value))
  }
  return root
}

test('the bundled Megan persona loads with her accepted voice tuning', () => {
  const config = loadConfig(process.cwd(), {})
  expect(config.persona.name).toBe('Megan')
  expect(config.persona.wakePhrase).toBe('Hey Megan')
  expect(config.persona.voice).toEqual({ model: 'en_US-amy-medium', lengthScale: 0.7, noiseScale: 0.5, noiseW: 0.8, volume: 0.65 })
  expect(config.persona.personality).toContain('{{user}}')
})

test('a custom persona, user and OpenAI-compatible harness are read from orb.config.json', () => {
  const root = project({
    'orb.config.json': { persona: 'personas/nova', user: { name: 'Sam' }, harness: { type: 'openai', endpoint: 'http://127.0.0.1:11434/v1', model: 'llama3.1' } },
    'personas/nova/persona.json': { name: 'Nova', wakePhrase: 'Hey Nova', voice: { model: 'en_GB-alba-medium', lengthScale: 1 } },
    'personas/nova/personality.md': 'You are {{name}}, helping {{ user }}.'
  })
  try {
    const config = loadConfig(root, {})
    expect(config.harness).toEqual({ type: 'openai', endpoint: 'http://127.0.0.1:11434/v1', model: 'llama3.1', apiKeyEnv: undefined, apiKeyFile: undefined, sendPersonality: true })
    expect(config.persona.voice).toMatchObject({ model: 'en_GB-alba-medium', lengthScale: 1, volume: 0.65 })
    expect(config.persona.fillers).toEqual([])
    expect(personalityPrompt(config)).toBe('You are Nova, helping Sam.')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.each([
  [{ harness: { type: 'openai', endpoint: 'https://x.test/v1', model: 'm', apiKey: 'sk-inline' } }, /not in orb.config.json/],
  [{ harness: { type: 'other' } }, /harness.type/],
  [{ harness: { type: 'hermes', profile: '../default' } }, /harness.profile/]
])('rejects unsafe or unknown settings %#', (config, message) => {
  const root = project({ 'orb.config.json': config, 'personas/megan/persona.json': { name: 'Megan', wakePhrase: 'Hey Megan' } })
  try { expect(() => loadConfig(root, {})).toThrow(message) } finally { rmSync(root, { recursive: true, force: true }) }
})

test.each([{ wakePhrase: 'Megan' }, { wakePhrase: 'Hey Megan 2' }, { voice: { model: '../../evil' } }, { voice: { lengthScale: 5 } }, { fillers: ['x'.repeat(81)] }])('rejects invalid persona %#', persona => {
  const root = project({ 'personas/megan/persona.json': { name: 'Megan', wakePhrase: 'Hey Megan', ...persona } })
  try { expect(() => loadConfig(root, {})).toThrow(/orb.config/) } finally { rmSync(root, { recursive: true, force: true }) }
})
