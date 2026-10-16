import { expect, test } from 'vitest'
import { SentenceBuffer } from './speech-text'
import { ChatController } from './chat-controller'
import { VoiceController } from './voice-controller'

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

async function fixture(first = 'First sentence. Next') {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const sent: Record<string, unknown>[] = []
  let voice: VoiceController
  const chat = new ChatController({
    async start() { return 'fixture-run' },
    async *events() { yield { data: { event: 'message.delta', delta: first } }; await gate; yield { data: { event: 'run.completed', output: first } } },
    async stop() {}, resetSession() {}
  }, s => voice.chatChanged(s))
  voice = new VoiceController(chat, m => sent.push(m as Record<string, unknown>), () => {})
  voice.receive({ type: 'ready' }); voice.mode(true)
  voice.receive({ type: 'state', state: 'listening' }); voice.receive({ type: 'transcript', text: 'fixture' })
  await tick()
  return { voice, chat, sent, release }
}

test('a typed replacement cancels draining voice audio but never becomes audible', async () => {
  const { voice, chat, sent, release } = await fixture()
  release(); await tick()
  const previous = sent.find(e => e.type === 'speech-begin')!.stream
  await chat.submit('typed replacement')
  voice.receive({ type: 'speech-ack', stream: previous, seq: 0 })
  expect(sent.filter(e => e.type === 'speech-begin')).toHaveLength(1)
})

test.each(['stop', 'mute', 'off', 'disconnect', 'error'] as const)('%s invalidates a gated generation and its stale state/ack/completion', async action => {
  const { voice, chat, sent, release } = await fixture()
  const id = chat.snapshot.speech!.id
  if (action === 'stop') voice.stop()
  if (action === 'mute') voice.mute()
  if (action === 'off') voice.mode(false)
  if (action === 'disconnect') voice.disconnected()
  if (action === 'error') voice.receive({ type: 'error', stream: id })
  const count = sent.filter(e => e.type === 'speech-append').length
  voice.receive({ type: 'speech-ack', stream: id, seq: 0 })
  voice.receive({ type: 'state', state: 'speaking', stream: id })
  release(); await tick()
  expect(sent.filter(e => e.type === 'speech-append')).toHaveLength(count)
  expect(voice.snapshot.state).not.toBe('speaking')
})

test('backlog overflow explicitly stops partial speech without blocking captions', async () => {
  const { voice, chat, sent, release } = await fixture()
  const snapshot = { ...chat.snapshot, speech: { ...chat.snapshot.speech!, phase: 'complete' as const, text: 'First sentence. ' + 'word '.repeat(5000) + 'Done.' } }
  voice.chatChanged(snapshot)
  expect(voice.snapshot.notice).toMatch(/backlog.*16 KiB.*Earlier speech may have played/)
  voice.receive({ type: 'speaker', registered: true, enrolling: false, count: 0, message: 'Voice filter ready.' })
  expect(voice.snapshot.notice).toMatch(/backlog.*16 KiB.*Earlier speech may have played/)
  expect(sent).toContainEqual({ type: 'cancel' })
  release(); await tick()
})

test('duplicate snapshots and final output never replay; PTT stays closed during idle generation gaps', async () => {
  const { voice, chat, sent, release } = await fixture()
  const id = chat.snapshot.speech!.id
  voice.receive({ type: 'speech-ack', stream: id, seq: 0 })
  voice.receive({ type: 'state', stream: id, state: 'idle' })
  voice.chatChanged(chat.snapshot); voice.chatChanged(chat.snapshot)
  release(); await tick()
  voice.hold(true)
  voice.chatChanged(chat.snapshot)
  voice.receive({ type: 'speech-ack', stream: id, seq: 1 })
  voice.chatChanged(chat.snapshot)
  expect(sent.filter(e => e.type === 'speech-append').map(e => e.text)).toEqual(['First sentence.', 'Next'])
  expect(sent.filter(e => e.type === 'speech-finish')).toHaveLength(1)
  expect(sent.some(e => e.type === 'start')).toBe(false)
  expect(voice.snapshot.speechActive).toBe(true)
  voice.receive({ type: 'speech-done', stream: id })
  expect(voice.snapshot.speechActive).toBe(false)
})

test('identical streaming snapshots do not flood pause frames', async () => {
  const { voice, chat, sent, release } = await fixture()
  const before = sent.length
  for (let i = 0; i < 1000; i++) voice.chatChanged(chat.snapshot)
  expect(sent.slice(before)).toEqual([])
  release(); await tick()
})

test('stop after backend completion releases the synthesis-gap capture pause without recording', async () => {
  const { voice, chat, sent, release } = await fixture()
  release(); await tick()
  expect(chat.snapshot.busy).toBe(false)
  voice.stop()
  expect(sent.at(-1)).toEqual({ type: 'pause', paused: false })
  expect(sent.some(e => e.type === 'start')).toBe(false)
})

test.each(['message.interim', 'tool.started', 'approval.request', 'run.failed'] as const)('%s aborts provisional audio without narrating its payload or replaying final prose', async event => {
  const sent: Record<string, unknown>[] = []
  let voice: VoiceController
  const chat = new ChatController({
    async start() { return 'provisional' }, async stop() {},
    async *events() {
      yield { data: { event: 'message.delta', delta: 'Provisional sentence. ' } }
      yield { data: { event, request_id: 'request', command: 'never speak this command', text: 'never speak interim', already_streamed: true } }
      if (event !== 'run.failed') yield { data: { event: 'run.completed', output: 'Different final prose.' } }
    }
  }, snapshot => voice.chatChanged(snapshot))
  voice = new VoiceController(chat, m => sent.push(m as Record<string, unknown>), () => {})
  voice.receive({ type: 'ready' }); voice.mode(true)
  voice.receive({ type: 'state', state: 'listening' }); voice.receive({ type: 'transcript', text: 'fixture' })
  await tick()
  expect(sent.filter(e => e.type === 'speech-append').map(e => e.text)).toEqual(['Provisional sentence.'])
  expect(sent.some(e => e.type === 'cancel')).toBe(true)
  if (event === 'run.failed') expect(chat.snapshot.notice).toContain('failed')
  else expect(voice.snapshot.notice).toMatch(/interim.*Earlier speech may have played/)
})

test('unstreamed interim captions/tools are not spoken; only explicit final output is', async () => {
  const sent: Record<string, unknown>[] = []
  let voice: VoiceController
  const chat = new ChatController({
    async start() { return 'interim' }, async stop() {},
    async *events() {
      yield { data: { event: 'message.interim', text: 'Tool preamble.', already_streamed: false } }
      yield { data: { event: 'tool.started', preview: 'secret command' } }
      yield { data: { event: 'message.delta', delta: 'Possible interim delta. ' } }
      yield { data: { event: 'run.completed', output: 'Actual final answer.' } }
    }
  }, snapshot => voice.chatChanged(snapshot))
  voice = new VoiceController(chat, m => sent.push(m as Record<string, unknown>), () => {})
  voice.receive({ type: 'ready' }); voice.mode(true)
  voice.receive({ type: 'state', state: 'listening' }); voice.receive({ type: 'transcript', text: 'fixture' })
  await tick()
  expect(sent.filter(e => e.type === 'speech-append').map(e => e.text)).toEqual(['Actual final answer.'])
})

test('new conversation cancels draining speech and a late acknowledgment cannot revive it', async () => {
  const { voice, chat, sent, release } = await fixture()
  release(); await tick()
  const id = chat.snapshot.speech!.id
  await chat.newConversation()
  const count = sent.length
  voice.receive({ type: 'speech-ack', stream: id, seq: 0 })
  expect(sent).toHaveLength(count)
  expect(sent.some(e => e.type === 'cancel')).toBe(true)
})

test('character boundaries hold markdown, decimals, abbreviations and closing quotes safely', () => {
  const source = '**Hello.** Dr. Smith paid 3.14 dollars. "Fine!" See [the guide](https://private.test/a.b). ![hidden.](image) `secret.` ```js\nsecret.\n``` https://hidden.test/a.b Done without punctuation'
  const buffer = new SentenceBuffer()
  const chunks: string[] = []
  for (let i = 1; i <= source.length; i++) chunks.push(...buffer.update(source.slice(0, i)))
  chunks.push(...buffer.update(source, true))
  chunks.push(...buffer.update(source, true))
  expect(chunks).toEqual(['Hello.', 'Dr. Smith paid 3.14 dollars.', '"Fine!"', 'See the guide.', 'Done without punctuation'])
})

test('incompatible already released prose is rejected rather than replayed', () => {
  const buffer = new SentenceBuffer()
  expect(buffer.update('First sentence. Next')).toEqual(['First sentence.'])
  expect(() => buffer.update('Revised sentence. Next', true)).toThrow(/revised/i)
})

test('nested formatting never exposes code or URLs inside emphasis/link labels', () => {
  const source = '**Hello `secret.` [guide](https://private.test/a).** Next safe sentence. '
  const buffer = new SentenceBuffer(), chunks: string[] = []
  for (let i = 1; i <= source.length; i++) chunks.push(...buffer.update(source.slice(0, i)))
  chunks.push(...buffer.update(source, true))
  expect(chunks.join(' ')).toBe('Hello guide. Next safe sentence.')
})

test.each(['`secret. ', '```js\nsecret. ', '[secret. ', '![secret.](https://hidden.', 'https://hidden.test/secret.', '**unfinished.'])('unfinished %s is held and omitted even at final completion', suffix => {
  const buffer = new SentenceBuffer()
  const chunks = buffer.update('Safe sentence. ' + suffix)
  chunks.push(...buffer.update('Safe sentence. ' + suffix, true))
  expect(chunks).toEqual(['Safe sentence.'])
})

test('voice-origin completed sentence is appended while backend completion remains gated', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const sent: Record<string, unknown>[] = []
  let voice: VoiceController
  const chat = new ChatController({
    async start() { return 'gated-run' },
    async *events() {
      yield { data: { event: 'message.delta', delta: 'First sentence. Second' } }
      await gate
      yield { data: { event: 'message.delta', delta: ' sentence. Third tail' } }
      yield { data: { event: 'run.completed', output: 'First sentence. Second sentence. Third tail' } }
    }, async stop() {}
  }, snapshot => voice.chatChanged(snapshot))
  voice = new VoiceController(chat, m => sent.push(m as Record<string, unknown>), () => {})
  voice.receive({ type: 'ready' }); voice.mode(true)
  voice.receive({ type: 'state', state: 'listening' })
  voice.receive({ type: 'transcript', text: 'fixture' })
  await tick()
  expect(chat.snapshot.busy).toBe(true)
  expect(sent.find(m => m.type === 'speech-append')?.text).toBe('First sentence.')
  const id = sent.find(m => m.type === 'speech-begin')!.stream
  voice.receive({ type: 'speech-ack', stream: id, seq: 0 })
  release(); await tick()
  voice.receive({ type: 'speech-ack', stream: id, seq: 1 })
  voice.receive({ type: 'speech-ack', stream: id, seq: 2 })
  expect(sent.filter(m => m.type === 'speech-append').map(m => m.text)).toEqual(['First sentence.', 'Second sentence.', 'Third tail'])
  expect(sent.filter(m => m.type === 'speech-finish')).toHaveLength(1)
  expect(chat.snapshot.answer).toBe('First sentence. Second sentence. Third tail')
})
