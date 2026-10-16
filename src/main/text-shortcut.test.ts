import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const main = readFileSync('src/main/index.ts', 'utf8')

test('registers the approved Ctrl+Shift+Space text toggle, never the other app chord', () => {
  expect(main).toContain("globalShortcut.register('CommandOrControl+Shift+Space', toggleInput)")
  expect(main).not.toContain('CommandOrControl+Alt+Space')
})

test('focused fallback accepts only a non-repeated Ctrl+Shift+Space key-down', () => {
  const expression = main.match(/if \((input.type === 'keyDown'.*)\) \{/)?.[1]
  expect(expression).toBeDefined()
  const accepts = new Function('input', `return ${expression}`)
  const input = { type: 'keyDown', isAutoRepeat: false, control: true, shift: true, alt: false, meta: false, code: 'Space' }
  expect(accepts(input)).toBe(true)
  for (const override of [{ shift: false }, { control: false }, { alt: true }, { meta: true }, { isAutoRepeat: true }, { type: 'keyUp' }, { code: 'Enter' }]) {
    expect(accepts({ ...input, ...override })).toBe(false)
  }
})

test('unavailable notice names the approved chord', () => {
  expect(main).toContain('Ctrl+Shift+Space is unavailable globally')
  expect(main).not.toContain('Ctrl+Alt+Space is unavailable globally')
})

test('native shortcut helper sends and describes Ctrl+Shift+Space', () => {
  const native = readFileSync('scripts/chat-native.ps1', 'utf8')
  expect(native).toContain("SendWait('^+ ')")
  expect(native).toContain("else{'Ctrl+Shift+Space'}")
  expect(native).not.toContain("SendWait('^% ')")
})

test('Text button help advertises Ctrl+Shift+Space', () => {
  const renderer = readFileSync('src/renderer/main.ts', 'utf8')
  expect(renderer).toContain("button.title = 'Text (Ctrl+Shift+Space)'")
})
