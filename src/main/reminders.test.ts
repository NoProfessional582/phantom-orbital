import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseReminder, ReminderInbox, type Reminder } from './reminders'

test('parseReminder keeps literal text, defaults the title and drops non-http links', () => {
  expect(parseReminder('{"message":"  Call Mom  "}')).toMatchObject({ title: 'Reminder', message: 'Call Mom', url: '' })
  expect(parseReminder('{"title":"Dentist","message":"3pm","url":"https://example.com/a"}')).toMatchObject({ title: 'Dentist', url: 'https://example.com/a' })
  expect(parseReminder('{"message":"x","url":"file:///c:/x"}')?.url).toBe('')
  expect(parseReminder('{"message":""}')).toBeUndefined()
  expect(parseReminder('not json')).toBeUndefined()
})

test('inbox publishes presence, delivers and deletes dropped reminders, and removes presence on stop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orb-reminders-'))
  try {
    let visible = true
    const got: Reminder[] = []
    const inbox = new ReminderInbox(dir, () => visible, r => got.push(r))
    inbox.start()
    expect(JSON.parse(readFileSync(inbox.presence, 'utf8'))).toMatchObject({ pid: process.pid, visible: true })
    visible = false; inbox.touch()
    expect(JSON.parse(readFileSync(inbox.presence, 'utf8')).visible).toBe(false)
    writeFileSync(join(inbox.inbox, 'a.json'), '{"message":"Take out the trash"}')
    writeFileSync(join(inbox.inbox, 'b.json.tmp'), '{"message":"partial"}')
    writeFileSync(join(inbox.inbox, 'c.json'), 'garbage')
    inbox.tick()
    expect(got.map(r => r.message)).toEqual(['Take out the trash'])
    expect(readdirSync(inbox.inbox)).toEqual(['b.json.tmp'])
    inbox.stop()
    expect(existsSync(inbox.presence)).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
