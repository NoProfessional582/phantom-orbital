import { expect, test } from 'vitest'
import { parseSse } from './sse'

test('parses JSON event names across byte chunks, UTF8, CRLF and multiline data', async () => {
  const bytes = new TextEncoder().encode(': keepalive\r\nid: 7\r\ndata: {"event":"message.delta",\r\ndata: "delta":"héllo"}\r\n\r\n')
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close() } })
  const events = []
  for await (const event of parseSse(stream)) events.push(event)
  expect(events).toEqual([{ id: '7', data: { event: 'message.delta', delta: 'héllo' } }])
})

test('rejects an oversized complete event even when it arrives in a single chunk', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ event: 'message.delta', delta: 'x'.repeat(2_000_001) })}\n\n`)); c.close() } })
  const consume = async () => { for await (const _event of parseSse(stream)) {} }
  await expect(consume()).rejects.toThrow('Event too large')
})
