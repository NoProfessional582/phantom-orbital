import { expect, test, vi } from 'vitest'
import { ChatController } from './chat-controller'

test('dismiss is presentation-only during streaming and persists until an actually new turn', async () => {
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  const stop = vi.fn(), resetSession = vi.fn()
  const chat = new ChatController({async start() { return 'run' }, async *events() {
    yield {data:{event:'message.delta',delta:'Partial.'}}
    await held
    yield {data:{event:'message.delta',delta:' Tail.'}}
    yield {data:{event:'run.completed',output:'Authoritative reply.'}}
  }, stop, resetSession}, () => {})
  const running = chat.submit('question')
  await vi.waitFor(() => expect(chat.snapshot.answer).toBe('Partial.'))
  const id = chat.snapshot.speech!.id
  chat.dismiss()
  expect(chat.snapshot.transcriptDismissed).toBe(true)
  expect(chat.snapshot.answer).toBe('Partial.')
  expect(chat.snapshot.speech!.text).toBe('Partial.')
  release(); await running
  chat.warn('A voice/caption notice')
  expect(chat.snapshot.transcriptDismissed).toBe(true)
  expect(chat.snapshot.speech).toEqual({id,text:'Authoritative reply.',phase:'complete'})
  expect(chat.snapshot.answer).toBe('Authoritative reply.')
  expect(stop).not.toHaveBeenCalled(); expect(resetSession).not.toHaveBeenCalled()
  await chat.submit('new turn')
  expect(chat.snapshot.transcriptDismissed).toBe(false)
  expect(chat.snapshot.speech!.id).not.toBe(id)
})
