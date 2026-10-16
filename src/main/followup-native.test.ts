import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, test } from 'vitest'
import { ChatController } from './chat-controller'
import { VoiceController } from './voice-controller'
import { HermesClient } from './hermes-client'
// @ts-expect-error The project mock has no separate declaration package.
import { startMock } from '../../scripts/mock-hermes.mjs'

// Explicit only: actual offline models, in-memory Piper input, deterministic
// silent device, and mock backend. No physical mic or ordinary app restart.
test.skipIf(process.env.ORB_FOLLOWUP_NATIVE !== '1')('native reply credit → direct second turn in same context → silence reset → new context', async () => {
  const mock = await startMock({ prefix: '/p/megan', key: 'synthetic-megan' })
  const child = spawn(resolve('sidecar/.venv/Scripts/python.exe'), ['-E', '-s', resolve('sidecar/tests/followup_probe.py')], { windowsHide: true, stdio: 'pipe' })
  let stderr = '', expired = false, started = false, voice: VoiceController
  const events: Record<string, unknown>[] = []
  const captureWhileBusy: object[] = []
  const sent: Record<string, unknown>[] = []
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const send = (message: object) => { sent.push(message as Record<string, unknown>); child.stdin.write(JSON.stringify(message) + '\n') }
  const client = new HermesClient(mock.endpoint + '/p/megan', 'synthetic-megan', fetch, true)
  const reset = client.resetSession.bind(client)
  client.resetSession = () => { reset(); expired = true }
  const chat = new ChatController(client, snapshot => voice.chatChanged(snapshot))
  const runPosts = () => mock.requests.filter((r: { path: string }) => r.path === '/p/megan/v1/runs')
  voice = new VoiceController(chat, send, () => {})
  const lines = createInterface({ input: child.stdout })
  let resolveReady!: () => void
  const ready = new Promise<void>(resolve => { resolveReady = resolve })
  lines.on('line', line => {
    const message = JSON.parse(line) as Record<string, unknown>
    events.push(message)
    if (message.type === 'state' && ['armed', 'followup', 'capturing'].includes(String(message.state)) && (chat.snapshot.busy || voice.snapshot.speechActive)) captureWhileBusy.push(message)
    voice.receive(message)
    if (message.type === 'speaker' && message.registered && !started) {
      started = true
      voice.mode(true); voice.activation(true); resolveReady()
    }
  })
  try {
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('native startup timeout: ' + stderr)), 90000).unref())])
    const deadline = Date.now() + 90000
    while (!expired && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    expect(expired, stderr + JSON.stringify(events)).toBe(true)
    expect(runPosts()).toHaveLength(2)
    expect(runPosts()[0].body.session_id).toBe(runPosts()[1].body.session_id)
    expect(events.filter(x => x.type === 'transcript')).toHaveLength(2)
    expect(events.filter(x => x.type === 'speech-done')).toHaveLength(2)
    expect(events.filter(x => x.type === 'followup-ended')).toHaveLength(1)
    expect(sent.filter(x => x.type === 'followup')).toHaveLength(2)
    expect(captureWhileBusy).toEqual([])
    expect(chat.snapshot.answer).toBe('')
    voice.mode(false)
    await chat.submit('next deliberately typed input')
    const sessions = runPosts().map((r: { body: { session_id: string } }) => r.body.session_id)
    expect(sessions).toHaveLength(3)
    expect(sessions[2]).not.toBe(sessions[0])
    expect(mock.sessions.size).toBe(2) // reset does not delete persisted history
    expect(mock.requests.every((r: { path: string }) => r.path.startsWith('/p/megan/'))).toBe(true)
    send({ type: 'probe-end' })
    const exit = await new Promise<number | null>(resolve => child.once('exit', resolve))
    expect(exit, stderr).toBe(0)
    const result = events.find(x => x.type === 'probe-result')!
    expect(result.micClosed).toBe(true)
    expect(Number(result.played)).toBeGreaterThan(0)
    console.log('NATIVE FOLLOWUP', JSON.stringify({ sessions, transcripts: events.filter(x => x.type === 'transcript').map(x => x.text), ...result }))
  } finally {
    lines.close(); child.kill(); await mock.close()
  }
}, 200000)
