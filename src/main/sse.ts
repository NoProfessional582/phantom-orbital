export interface SseEvent { id?: string; data: Record<string, unknown> }
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader(), decoder = new TextDecoder()
  let buffer = '', id: string | undefined, data: string[] = []
  try {
    while (true) {
      const part = await reader.read()
      buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true })
      let match: RegExpExecArray | null
      while ((match = /\r\n|\r(?!$)|\n/.exec(buffer))) {
        const line = buffer.slice(0, match.index)
        if (line.length + data.join('').length > 2_000_000) throw new Error('Event too large')
        buffer = buffer.slice(match.index + match[0].length)
        if (!line) {
          if (data.length) {
            const parsed: unknown = JSON.parse(data.join('\n'))
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid event')
            yield { id, data: parsed as Record<string, unknown> }
          }
          id = undefined; data = []
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':')
          const field = colon < 0 ? line : line.slice(0, colon)
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
          if (field === 'data') data.push(value)
          if (field === 'id' && !value.includes('\0')) id = value
        }
      }
      if (buffer.length + data.join('').length > 2_000_000) throw new Error('Event too large')
      if (part.done) break
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
