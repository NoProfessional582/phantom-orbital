import { expect, test } from 'vitest'
import { existsSync } from 'node:fs'

test('local speech strips markdown URLs and code without losing later sentences', async () => {
  expect(existsSync('src/main/speech-text.ts'), 'speech sanitizer not implemented').toBe(true)
  const { speechChunks } = await import('./speech-text')
  const answer = '**Hello.** See [the guide](https://example.com/private). https://secret.invalid/token\n```js\nthrow secret\n```\n`command`\n' + 'Long answer. '.repeat(100)
  const chunks = speechChunks(answer)
  expect(chunks[0]).toBe('Hello.')
  expect(chunks.join(' ')).toContain('See the guide.')
  expect(chunks.join(' ')).not.toMatch(/https|secret|throw|command|[*`]/)
  expect(chunks.join(' ')).toBe('Hello. See the guide. ' + 'Long answer. '.repeat(100).trim())
  expect(answer.length).toBeGreaterThan(600)
})

test('long prose and unbroken unicode tokens are bounded per synthesis without dropping text', async () => {
  const { speechChunks } = await import('./speech-text')
  for (const answer of ['word '.repeat(2000).trim(), '😀'.repeat(1000), 'A. '.repeat(2000).trim()]) {
    const chunks = speechChunks(answer)
    expect(chunks.every(s => Array.from(s).length <= 400)).toBe(true)
    expect(chunks.join('').replace(/\s/g, '')).toBe(answer.replace(/\s/g, ''))
    expect(chunks.join(' ')).not.toContain('\ufffd')
  }
})

test('stray markup characters never silence the rest of a streamed reply', async () => {
  const { SentenceBuffer } = await import('./speech-text')
  const cases: [string, string][] = [
    ['It takes < 5 minutes. Then you are done. Enjoy.', 'It takes 5 minutes. Then you are done. Enjoy.'],
    ['If x < 3 and y > 4 we stop. Done now.', 'If x 3 and y > 4 we stop. Done now.'],
    ['Use the `ls command. Then cd home. Bye.', 'Use the ls command. Then cd home. Bye.'],
    ['Note [sic this is fine. Then more. End.', 'Note sic this is fine. Then more. End.'],
    ['A **bold start. Then plain. End.', 'A bold start. Then plain. End.'],
    ['Keep <b>this</b> word. Done.', 'Keep this word. Done.'],
    ['Read [the guide](https://example.com/x). Then rest.', 'Read the guide. Then rest.']
  ]
  for (const [reply, spoken] of cases) {
    const once = new SentenceBuffer().update(reply, true).join(' ').replace(/\s+/g, ' ')
    expect(once, reply).toBe(spoken)
    // Streaming in small frames must reach the same result without revising released prose.
    const streamed = new SentenceBuffer(), parts: string[] = []
    for (let end = 1; end < reply.length; end += 3) parts.push(...streamed.update(reply.slice(0, end)))
    parts.push(...streamed.update(reply, true))
    expect(parts.join(' ').replace(/\s+/g, ' '), reply).toBe(spoken)
  }
})

test('an unclosed inline marker is released once the inline window passes', async () => {
  const { SentenceBuffer } = await import('./speech-text')
  const buffer = new SentenceBuffer()
  const reply = 'Start `here. ' + 'More words follow. '.repeat(30)
  // Before the reply finishes, prose after the stray backtick is still spoken.
  expect(buffer.update(reply).join(' ')).toContain('More words follow.')
})
