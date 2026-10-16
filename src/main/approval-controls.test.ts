import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('approval IPC checks exact main frame and hotkey requires a visible focused card', async () => {
  const { trustedControl, canApproveHotkey } = await import('./approval-controls')
  const frame = {}, contents = { mainFrame: frame }
  expect(trustedControl({ sender: contents, senderFrame: frame }, contents, false)).toBe(true)
  expect(trustedControl({ sender: {}, senderFrame: frame }, contents, false)).toBe(false)
  expect(trustedControl({ sender: contents, senderFrame: {} }, contents, false)).toBe(false)
  expect(trustedControl({ sender: contents, senderFrame: frame }, contents, true)).toBe(false)
  const card = { id: 'synthetic-card', action: 'Synthetic action', pending: false }
  expect(canApproveHotkey(card, true, true, false, card.id)).toBe(true)
  expect(canApproveHotkey(card, true, true, false, 'old-card')).toBe(false)
  expect(canApproveHotkey(card, true, true, false, undefined)).toBe(false)
  for (const [approval, visible, focused, locked] of [[card, false, true, false], [card, true, false, false], [card, true, true, true], [undefined, true, true, false], [{ ...card, pending: true }, true, true, false]] as const) expect(canApproveHotkey(approval, visible, focused, locked, card.id)).toBe(false)
})

test('UI has deliberate once/deny and narrow IPC; hotkey registration is only a reservation', () => {
  const main = readFileSync('src/main/index.ts', 'utf8'), renderer = readFileSync('src/renderer/main.ts', 'utf8'), preload = readFileSync('src/preload/index.ts', 'utf8')
  expect(main).toContain("globalShortcut.register('Control+Alt+Y', () => {})")
  expect(main).toContain('trustedControl(event, win?.webContents, locked)')
  expect(main).toContain("message.type === 'approval-hotkey'")
  expect(renderer).toContain("'Approve once'")
  expect(renderer).toContain("'Deny'")
  expect(renderer).toContain('event.isTrusted')
  expect(preload).toContain("ipcRenderer.send('orb:approval', { id, choice })")
  expect(main).toContain("channel === 'new-conversation'")
  expect(main).toContain('synthetic: mock')
  expect(renderer).toContain('root.dataset.synthetic')
})
