import { expect, test } from 'vitest'
import { SidecarClient } from './sidecar-client'

test.each(['frame', 'backlog'])('outgoing %s overflow closes transport visibly without sending', kind => {
  let deaths = 0, closed = 0
  const sent: string[] = []
  const client = new SidecarClient('unused', () => {}, () => { deaths++ })
  const socket = { readyState: WebSocket.OPEN, bufferedAmount: kind === 'backlog' ? 16384 : 0, send: (s: string) => sent.push(s), close: () => { closed++ } }
  Object.assign(client, { socket })
  client.send({ type: 'speech-append', text: kind === 'frame' ? '界'.repeat(6000) : 'First sentence.' })
  expect(sent).toEqual([])
  expect(closed).toBe(1)
  expect(deaths).toBe(1)
})
