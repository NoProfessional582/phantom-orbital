import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

// orb.config.json (gitignored) picks the persona pack, the user and the AI harness.
// orb.config.example.json documents every field. Everything here is local and
// read only in Electron main; API keys are referenced, never stored in the file.

export interface PersonaVoice { model: string; lengthScale: number; noiseScale: number; noiseW: number; volume: number }
/** Built-in lines the persona shows or says; {{name}} and {{user}} are filled in. */
export interface PersonaMessages { stillWorking: string; backgroundDone: string; voicePreview: string }
export interface Persona { name: string; wakePhrase: string; personality: string; voice: PersonaVoice; fillers: string[]; progress: string[]; messages: PersonaMessages }
export type HarnessConfig =
  | { type: 'hermes'; endpoint?: string; home?: string; profile?: string }
  | { type: 'openai'; endpoint: string; model: string; apiKeyEnv?: string; apiKeyFile?: string; sendPersonality: boolean }
export interface OrbConfig { user: { name: string }; persona: Persona; harness: HarnessConfig; speakerFilter: boolean }

export const DEFAULT_MESSAGES: PersonaMessages = {
  stillWorking: 'Still working on it…',
  backgroundDone: '{{name}} finished a background task',
  voicePreview: 'Hello {{user}}. I am {{name}}, speaking locally on this computer.'
}

export const DEFAULT_VOICE: PersonaVoice = { model: 'en_US-amy-medium', lengthScale: 0.7, noiseScale: 0.5, noiseW: 0.8, volume: 0.65 }

function fail(message: string): never { throw new Error(`orb.config: ${message}`) }
function text(value: unknown, field: string, max: number, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) fail(`${field} must be a short single-line string`)
  return value.trim()
}
function number(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${field} must be a number from ${min} to ${max}`)
  return value
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`)
  return value as Record<string, unknown>
}
function readJson(path: string, field: string): Record<string, unknown> {
  try { return object(JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')), field) }
  catch (error) { throw error instanceof Error && error.message.startsWith('orb.config') ? error : new Error(`orb.config: cannot read ${field} (${path})`) }
}

/** Wake phrases must be plain English words the keyword model can spell. */
export function validWakePhrase(value: string): boolean {
  return /^[A-Za-z]+(?:[ '-][A-Za-z]+){1,3}$/.test(value)
}

export function loadPersona(dir: string): Persona {
  const raw = readJson(join(dir, 'persona.json'), 'persona.json')
  const name = text(raw.name, 'persona name', 40)
  const wakePhrase = text(raw.wakePhrase, 'wakePhrase', 40)
  if (!validWakePhrase(wakePhrase)) fail('wakePhrase must be 2–4 plain words, e.g. "Hey Nova"')
  const voiceRaw = object(raw.voice, 'voice')
  const model = text(voiceRaw.model, 'voice.model', 80, DEFAULT_VOICE.model)
  if (!/^[a-z]{2,3}_[A-Z]{2}-[a-z0-9_]+-(?:x_low|low|medium|high)$/.test(model)) fail('voice.model must be a Piper voice id such as en_US-amy-medium')
  const voice: PersonaVoice = {
    model,
    lengthScale: number(voiceRaw.lengthScale, 'voice.lengthScale', 0.3, 2, DEFAULT_VOICE.lengthScale),
    noiseScale: number(voiceRaw.noiseScale, 'voice.noiseScale', 0, 1.5, DEFAULT_VOICE.noiseScale),
    noiseW: number(voiceRaw.noiseW, 'voice.noiseW', 0, 1.5, DEFAULT_VOICE.noiseW),
    volume: number(voiceRaw.volume, 'voice.volume', 0.05, 1, DEFAULT_VOICE.volume)
  }
  // fillers: said when a voice request is captured. progress: said when a reply goes quiet for a while.
  const lines = (field: 'fillers' | 'progress') => {
    const value = raw[field]
    if (value !== undefined && (!Array.isArray(value) || value.length > 40)) fail(`${field} must be a list of at most 40 short lines`)
    return ((value as unknown[] | undefined) ?? []).map((line, i) => text(line, `${field}[${i}]`, 80))
  }
  const fillers = lines('fillers'), progress = lines('progress')
  const messagesRaw = object(raw.messages, 'messages')
  const messages = Object.fromEntries((Object.keys(DEFAULT_MESSAGES) as (keyof PersonaMessages)[])
    .map(key => [key, text(messagesRaw[key], `messages.${key}`, 160, DEFAULT_MESSAGES[key])])) as unknown as PersonaMessages
  let personality = ''
  const personalityPath = join(dir, 'personality.md')
  if (existsSync(personalityPath)) personality = readFileSync(personalityPath, 'utf8').replace(/^﻿/, '').trim()
  if (personality.length > 20_000) fail('personality.md must be under 20,000 characters')
  return { name, wakePhrase, personality, voice, fillers, progress, messages }
}

function harness(raw: Record<string, unknown>): HarnessConfig {
  const type = raw.type ?? 'hermes'
  if (type === 'hermes') {
    const profile = raw.profile === undefined ? undefined : text(raw.profile, 'harness.profile', 64)
    if (profile !== undefined && !/^[A-Za-z0-9_-]+$/.test(profile)) fail('harness.profile may contain only letters, digits, _ and -')
    return {
      type, profile,
      endpoint: raw.endpoint === undefined ? undefined : text(raw.endpoint, 'harness.endpoint', 300),
      home: raw.home === undefined ? undefined : text(raw.home, 'harness.home', 300)
    }
  }
  if (type === 'openai') {
    if (raw.apiKey !== undefined) fail('put the key in an environment variable (apiKeyEnv) or a file (apiKeyFile), not in orb.config.json')
    return {
      type,
      endpoint: text(raw.endpoint, 'harness.endpoint', 300),
      model: text(raw.model, 'harness.model', 200),
      apiKeyEnv: raw.apiKeyEnv === undefined ? undefined : text(raw.apiKeyEnv, 'harness.apiKeyEnv', 100),
      apiKeyFile: raw.apiKeyFile === undefined ? undefined : text(raw.apiKeyFile, 'harness.apiKeyFile', 300),
      sendPersonality: raw.sendPersonality === undefined ? true : raw.sendPersonality === true
    }
  }
  fail('harness.type must be "hermes" or "openai"')
}

/** Reads orb.config.json from the app root (or ORB_CONFIG). Missing file means the bundled Megan persona on Hermes. */
export function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): OrbConfig {
  const path = env.ORB_CONFIG ? resolve(root, env.ORB_CONFIG) : join(root, 'orb.config.json')
  const raw = existsSync(path) ? readJson(path, 'orb.config.json') : {}
  const personaPath = text(raw.persona, 'persona', 300, 'personas/megan')
  const user = object(raw.user, 'user')
  if (raw.speakerFilter !== undefined && typeof raw.speakerFilter !== 'boolean') fail('speakerFilter must be true or false')
  return {
    user: { name: text(user.name, 'user.name', 60, 'the user') },
    persona: loadPersona(isAbsolute(personaPath) ? personaPath : join(root, personaPath)),
    harness: harness(object(raw.harness, 'harness')),
    // Off by default: any voice is transcribed. true requires an enrolled voice match.
    speakerFilter: raw.speakerFilter === true
  }
}

function fill(text: string, config: OrbConfig): string {
  return text.replace(/\{\{\s*name\s*\}\}/g, config.persona.name).replace(/\{\{\s*user\s*\}\}/g, config.user.name)
}

/** Personality text with {{name}} / {{user}} filled in. */
export function personalityPrompt(config: OrbConfig): string { return fill(config.persona.personality, config) }

/** A built-in persona line with {{name}} / {{user}} filled in. */
export function personaMessage(config: OrbConfig | undefined, key: keyof PersonaMessages): string {
  return config ? fill(config.persona.messages[key], config) : DEFAULT_MESSAGES[key].replace('{{name}}', 'Megan').replace('{{user}}', 'there')
}
