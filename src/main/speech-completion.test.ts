import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { expect, test } from 'vitest'
import { ChatController } from './chat-controller'
import { VoiceController } from './voice-controller'
import { speechChunks, SPEECH_FRAME_BYTES } from './speech-text'

const response = readFileSync('sidecar/tests/fixtures/speech-cutoff.txt', 'utf8').replace(/\r\n/g, '\n').trim()
type Event = Record<string, unknown>

function probe(real = false) {
  const child = spawn(resolve('sidecar/.venv/Scripts/python.exe'), ['-E', '-s', 'sidecar/tests/streaming_probe.py', ...(real ? ['--real'] : [])], {
    env: { ...process.env, HF_HUB_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe'
  })
  const events: Event[] = [], listeners = new Set<() => void>()
  let receive: (event: Event) => void = () => {}, stderr = ''
  child.stderr.on('data', data => { stderr += data.toString() })
  createInterface({ input: child.stdout }).on('line', line => {
    const event = JSON.parse(line) as Event
    events.push(event); receive(event)
    for (const listener of listeners) listener()
  })
  function wait(predicate: (event: Event) => boolean): Promise<Event> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Probe timeout: ${stderr}; ${JSON.stringify(events.slice(-5))}`)) }, 120_000)
      function check() {
        const event = events.find(predicate)
        if (event) { clearTimeout(timer); listeners.delete(check); resolve(event) }
      }
      listeners.add(check); check()
    })
  }
  return { child, events, wait, setReceive(fn: typeof receive) { receive = fn }, send(message: object) { child.stdin.write(JSON.stringify(message) + '\n') },
    async close() {
      child.stdin.end()
      const code = await new Promise(resolve => child.once('exit', resolve))
      expect(code, stderr).toBe(0)
    } }
}

test('gated backend streams first synthesis AND sample writer before completion, then complete ordered 907-character reply', async () => {
  expect(response.replace(/\s+/g, ' ').length).toBe(907)
  const local = probe(process.env.ORB_REAL_SPEECH === '1')
  let release!: () => void, voice: VoiceController
  const gate = new Promise<void>(resolve => { release = resolve })
  const order: string[] = [], sent: Event[] = []
  const chat = new ChatController({
    async start() { return 'gated-completeness-run' },
    async *events() {
      const first = speechChunks(response)[0]
      order.push('first-text')
      yield { data: { event: 'message.delta', delta: first + ' ' } }
      await gate
      // Deliver the remaining answer character by character while playback drains.
      for (const delta of response.slice(first.length + 1)) yield { data: { event: 'message.delta', delta } }
      order.push('backend-completed')
      yield { data: { event: 'run.completed', output: response } }
    }, async stop() {}
  }, snapshot => voice.chatChanged(snapshot))
  voice = new VoiceController(chat, message => { sent.push(message as Event); local.send(message) }, () => {})
  local.setReceive(event => {
    if (event.type === 'probe-synthesis' && !order.includes('first-synthesis')) order.push('first-synthesis')
    if (event.type === 'probe-writer' && !order.includes('first-sample-writer')) order.push('first-sample-writer')
    voice.receive(event)
  })
  try {
    await local.wait(e => e.type === 'ready')
    voice.mode(true)
    voice.receive({ type: 'state', state: 'listening' })
    voice.receive({ type: 'transcript', text: 'gated fixture', device: 'cpu' })
    await local.wait(e => e.type === 'probe-writer')
    expect(chat.snapshot.busy).toBe(true)
    expect(order).toEqual(['first-text', 'first-synthesis', 'first-sample-writer'])
    release()
    await local.wait(e => e.type === 'speech-done')
    const played = local.events.filter(e => e.type === 'probe-played')
    expect(played.map(e => e.text)).toEqual(speechChunks(response))
    expect(played.map(e => e.text).join(' ')).toBe(response.replace(/\s+/g, ' '))
    expect(played.at(-1)?.text).toBe('Charm is simply part of the interface.')
    expect(played.every(e => Number(e.samples) > 0)).toBe(true)
    expect(sent.filter(e => e.type === 'speech-finish')).toHaveLength(1)
    expect(sent.every(e => Buffer.byteLength(JSON.stringify(e), 'utf8') <= SPEECH_FRAME_BYTES)).toBe(true)
    expect(chat.snapshot.answer).toBe(response)
    console.log('Gated local speech:', JSON.stringify({ realAmy: process.env.ORB_REAL_SPEECH === '1', order, chunks: played.length, samples: played.reduce((n, e) => n + Number(e.samples), 0), final: played.at(-1)?.text }))
  } finally { release(); await local.close() }
}, 180_000)

test('actual sample-writer cancellation discards remaining queued/stale output', async () => {
  const local = probe(process.env.ORB_REAL_SPEECH === '1')
  try {
    await local.wait(e => e.type === 'ready')
    local.send({ type: 'mode', enabled: true })
    local.send({ type: 'speech-begin', stream: 'cancel-run' })
    local.send({ type: 'probe-hold' })
    local.send({ type: 'speech-append', stream: 'cancel-run', seq: 0, text: 'Cancel this local sentence during playback.' })
    await local.wait(e => e.type === 'probe-writer')
    local.send({ type: 'speech-append', stream: 'cancel-run', seq: 1, text: 'Never synthesize the queued remainder.' })
    local.send({ type: 'cancel' })
    local.send({ type: 'speech-append', stream: 'cancel-run', seq: 2, text: 'Stale text.' })
    local.send({ type: 'speech-finish', stream: 'cancel-run' })
    local.send({ type: 'probe-barrier' })
    await local.wait(e => e.type === 'probe-barrier')
  } finally { await local.close() }
  expect(local.events.filter(e => e.type === 'probe-synthesis').map(e => e.text)).toEqual(['Cancel this local sentence during playback.'])
  expect(local.events.filter(e => e.type === 'probe-played')).toEqual([])
  console.log('Local cancellation: first sample writer entered; cancel; zero completed chunks; stale append ignored.')
}, 180_000)

test('500 sentences and long prose have no 100-sentence or 600-character truncation', async () => {
  for (const answer of ['Sentence. '.repeat(500) + 'Final phrase.', 'long prose '.repeat(800) + 'Final phrase.']) {
    const sent: Event[] = []
    let voice: VoiceController
    const chat = new ChatController({ async start() { return 'complete' }, async *events() { yield { data: { event: 'run.completed', output: answer } } }, async stop() {} }, snapshot => voice.chatChanged(snapshot))
    voice = new VoiceController(chat, message => sent.push(message as Event), () => {})
    voice.receive({ type: 'ready' }); voice.mode(true)
    voice.receive({ type: 'state', state: 'listening' }); voice.receive({ type: 'transcript', text: 'fixture' })
    await new Promise(resolve => setTimeout(resolve, 5))
    let seq = 0
    while (sent.some(e => e.type === 'speech-append' && e.seq === seq)) voice.receive({ type: 'speech-ack', stream: chat.snapshot.speech!.id, seq: seq++ })
    expect(sent.filter(e => e.type === 'speech-append').map(e => e.text).join(' ')).toBe(answer)
    expect(sent.filter(e => e.type === 'speech-finish')).toHaveLength(1)
  }
})