import { expect, test } from 'vitest'
import { ChatController } from './chat-controller'
import { OpenAiClient, validOpenAiEndpoint } from './openai-client'

function sse(lines: string[]) {
  return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(l)); c.close() } }), { headers: { 'content-type': 'text/event-stream' } })
}
const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

test('streams deltas, completes and keeps conversation history with the personality as system prompt', async () => {
  const bodies: any[] = []
  const transport = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    return sse([chunk('Hel'), chunk('lo.'), 'data: [DONE]\n\n'])
  }) as unknown as typeof fetch
  const client = new OpenAiClient('http://127.0.0.1:11434/v1', 'test-model', '', 'You are Nova.', transport)
  const snapshots: string[] = []
  const chat = new ChatController(client, s => snapshots.push(s.answer))
  await chat.submit('hi')
  expect(chat.snapshot.answer).toBe('Hello.')
  await chat.submit('again')
  expect(bodies[1].messages).toEqual([
    { role: 'system', content: 'You are Nova.' }, { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'Hello.' }, { role: 'user', content: 'again' }
  ])
  expect(bodies[0]).toMatchObject({ model: 'test-model', stream: true })
  client.resetSession()
  await chat.submit('fresh')
  expect(bodies[2].messages).toHaveLength(2)
})

test('sends the key only as a bearer header and never echoes it', async () => {
  let auth = ''
  const transport = (async (url: string, init: RequestInit) => {
    auth = (init.headers as Record<string, string>).Authorization
    expect(url).not.toContain('sk-synthetic')
    return sse([chunk('key sk-synthetic leaked'), 'data: [DONE]\n\n'])
  }) as unknown as typeof fetch
  const chat = new ChatController(new OpenAiClient('https://api.example.test/v1', 'm', 'sk-synthetic', '', transport), () => {})
  await chat.submit('hi')
  expect(auth).toBe('Bearer sk-synthetic')
  expect(chat.snapshot.answer).toBe('key [redacted] leaked')
})

test('server errors finish the run as failed', async () => {
  const transport = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
  const chat = new ChatController(new OpenAiClient('http://localhost:1234/v1', 'm', '', '', transport), () => {})
  await chat.submit('hi')
  expect(chat.snapshot.busy).toBe(false)
})

test.each(['http://example.com/v1', 'ftp://127.0.0.1/v1', 'https://u:p@example.com/v1', 'https://example.com/v1?key=x', 'nope'])('rejects unsafe endpoint %s', endpoint => {
  expect(() => validOpenAiEndpoint(endpoint)).toThrow()
})
