// Match sidecar/server.py's existing UTF-8 JSON frame budget. No prefix truncation.
export const SPEECH_FRAME_BYTES = 16384
export const SPEECH_CHUNK_CHARACTERS = 400

// Inline Markdown (code, emphasis, link labels, tags) must close within this
// many characters. Past it, or at the end of the reply, an opener is a stray
// character: skipped, never allowed to silence the rest of the reply.
const INLINE_WINDOW = 300
const TAG = /^<\/?[A-Za-z][\w:-]*(?:\s[^<>]{0,200})?>/
const PARTIAL_TAG = /^<(?:\/?(?:[A-Za-z][\w:-]*(?:\s[^<>]{0,200})?)?)?$/

// Only commit delimited tokens. An unfinished Markdown construct hides its
// suffix; a later frame can never turn already released prose into code/a URL.
// Each decision is fixed once INLINE_WINDOW characters follow it, so more text
// never revises it.
function stableProse(raw: string, final: boolean): string {
  let out = '', i = 0
  // Index of the closing token within the window, -1 if it can't close, undefined to wait.
  const closing = (token: string, from: number, start: number) => {
    const end = raw.indexOf(token, from)
    if (end >= 0 && end - start <= INLINE_WINDOW) return end
    return final || raw.length - start > INLINE_WINDOW ? -1 : undefined
  }
  while (i < raw.length) {
    const rest = raw.slice(i)
    const fence = /^(?:```|~~~)/.exec(rest)?.[0]
    if (fence) {
      // Code blocks may be long; an unclosed final block is code, not prose.
      const end = raw.indexOf(fence, i + 3)
      if (end < 0) break
      out += ' '; i = end + 3; continue
    }
    const marker = /^(?:`+|\*\*|__|~~)/.exec(rest)?.[0]
    if (marker) {
      const end = closing(marker, i + marker.length, i)
      if (end === undefined) break
      if (end < 0) { i += marker.length; continue }
      out += marker.startsWith('`') ? ' ' : stableProse(raw.slice(i + marker.length, end), true)
      i = end + marker.length; continue
    }
    if (/^!?\[/.test(rest)) {
      const close = closing(']', i, i)
      if (close === undefined || close >= 0 && close + 1 === raw.length && !final) break
      if (close < 0) { i += raw[i] === '!' ? 2 : 1; continue }
      if (raw[close + 1] === '(') {
        const end = closing(')', close + 2, i)
        if (end === undefined) break
        if (end >= 0) {
          out += raw[i] === '!' ? ' ' : stableProse(raw.slice(i + 1, close), true)
          i = end + 1; continue
        }
      }
      // Reference links and unfinished labels are not safe prose.
      out += ' '; i = close + 1; continue
    }
    if (raw[i] === '<') {
      const tag = TAG.exec(rest)?.[0]
      if (tag) { out += ' '; i += tag.length; continue }
      if (!final && PARTIAL_TAG.test(rest)) break
      // A comparison such as "< 5", not markup.
      out += ' '; i++; continue
    }
    if (/\s/.test(raw[i])) { out += raw[i++]; continue }
    const token = /^\S+/.exec(rest)![0]
    if (i + token.length === raw.length && !final) break
    // Re-process punctuation adjacent to markup rather than swallowing it.
    const plain = /^[^\s`[<*_~!]+|^!(?!\[)/.exec(rest)?.[0]
    if (/(?:https?:\/\/|www\.)/i.test(token)) { i += token.length; out += ' '; continue }
    if (plain) { out += plain; i += plain.length; continue }
    // Single emphasis markers are formatting, not spoken characters.
    i++
  }
  return out.replace(/^\s*(?:#{1,6}|[-*>]|\d+\.)\s+/gm, '').replace(/[*_~|]/g, '').replace(/\s+/g, ' ').trimStart()
}

export class SentenceBuffer {
  private released = ''
  update(raw: string, final = false): string[] {
    const prose = stableProse(raw, final)
    if (!prose.startsWith(this.released)) throw new Error('Streamed prose revised after speech was released')
    let end = this.released.length
    // A following whitespace/word proves punctuation and closing quotes ended.
    for (const match of prose.slice(end).matchAll(/[.!?]+["'”’)]*(?=\s|$)/g)) {
      const boundary = this.released.length + match.index! + match[0].length
      if (!final && boundary === prose.length) continue
      const prefix = prose.slice(0, boundary)
      if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.$/i.test(prefix) || /\b[A-Z]\.$/.test(prefix)) continue
      end = boundary
    }
    if (final) end = prose.length
    const next = prose.slice(this.released.length, end).trim()
    this.released = prose.slice(0, end)
    return proseChunks(next)
  }
}

// Full answer stays in captions; bound each native synthesis call, not its tail.
export function speechChunks(answer: string): string[] {
  const text = answer
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(new RegExp(TAG.source.slice(1), 'g'), ' ')
    .replace(/^\s*(?:#{1,6}|[-*>]|\d+\.)\s+/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ').trim()
  return proseChunks(text)
}

function proseChunks(text: string): string[] {
  const chunks: string[] = [], sentences: string[] = []
  let start = 0
  for (const match of text.matchAll(/[.!?]+["'”’)]*(?=\s|$)/g)) {
    const end = match.index! + match[0].length
    if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.$/i.test(text.slice(0, end)) || /\b[A-Z]\.$/.test(text.slice(0, end))) continue
    sentences.push(text.slice(start, end)); start = end
  }
  if (start < text.length) sentences.push(text.slice(start))
  for (const sentence of sentences) {
    let remaining = Array.from(sentence.trim())
    while (remaining.length > SPEECH_CHUNK_CHARACTERS) {
      const space = remaining.slice(0, SPEECH_CHUNK_CHARACTERS + 1).lastIndexOf(' ')
      const end = space > 0 ? space : SPEECH_CHUNK_CHARACTERS
      chunks.push(remaining.slice(0, end).join(''))
      remaining = remaining.slice(end)
      if (remaining[0] === ' ') remaining.shift()
    }
    if (remaining.length) chunks.push(remaining.join(''))
  }
  return chunks
}
