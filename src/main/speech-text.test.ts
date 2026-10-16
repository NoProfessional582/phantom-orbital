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
