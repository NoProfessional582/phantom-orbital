import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

test('main launches token-authenticated loopback sidecar offline and owns shutdown', async () => {
  expect(existsSync('src/main/sidecar-client.ts'), 'sidecar lifecycle not implemented').toBe(true)
  const { SidecarClient } = await import('./sidecar-client')
  const events: Record<string, unknown>[] = []
  const client = new SidecarClient(resolve('sidecar'), event => events.push(event), () => {}, false, resolve('.cache/m5-client/voice-profile.json'))
  await client.start()
  expect(events).toContainEqual({ type: 'ready' })
  client.send({ type: 'mode', enabled: false })
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(events).toContainEqual({ type: 'state', state: 'idle' })
  const child = client.pid
  expect(child).toBeGreaterThan(0)
  await client.close()
  expect(client.pid).toBeUndefined()
}, 15_000)

test('missing isolated Python fails without blocking shutdown or starting another environment', async () => {
  const { SidecarClient } = await import('./sidecar-client')
  const client = new SidecarClient(resolve('.cache/absent-sidecar'), () => {}, () => {})
  await expect(client.start()).rejects.toThrow('Local voice sidecar unavailable')
  await Promise.race([client.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown hung')), 200))])
  expect(client.pid).toBeUndefined()
})

test('sidecar death can restart locally, and a restart that comes up resets the attempt limit', async () => {
  const { SidecarClient } = await import('./sidecar-client')
  let deaths = 0
  const client = new SidecarClient(resolve('sidecar'), () => {}, () => { deaths++ }, false, resolve('.cache/m5-client/voice-profile.json'))
  try {
    await client.start()
    const first = client.pid!
    process.kill(first)
    await new Promise(resolve => setTimeout(resolve, 150))
    await client.restart()
    expect(client.pid).not.toBe(first)
    expect(deaths).toBe(1)
    await client.restart()
    await client.restart() // a third works too: the limit counts failures in a row
    expect(client.pid).toBeGreaterThan(0)
  } finally { await client.close() }
}, 30_000)

test('two failed restarts in a row hit the limit', async () => {
  const { SidecarClient } = await import('./sidecar-client')
  const client = new SidecarClient(resolve('.cache/absent-sidecar'), () => {}, () => {})
  await expect(client.restart()).rejects.toThrow('Local voice sidecar unavailable')
  await expect(client.restart()).rejects.toThrow('Local voice sidecar unavailable')
  await expect(client.restart()).rejects.toThrow('restart limit')
})
