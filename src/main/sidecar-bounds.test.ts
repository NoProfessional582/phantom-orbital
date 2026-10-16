import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'

const launcher = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: launcher.spawn }))
import { SidecarClient } from './sidecar-client'

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

test('unconfirmed sidecar shutdown fails boundedly rather than launching an overlapping replacement', async () => {
  vi.useFakeTimers()
  const child = Object.assign(new EventEmitter(), {
    pid: 123, exitCode: null, signalCode: null,
    stderr: { resume() {} }, stdout: new EventEmitter(), stdin: { end() {} }, kill: vi.fn(() => false)
  })
  launcher.spawn.mockReturnValue(child)
  const client = new SidecarClient('synthetic-only', () => {}, () => {})
  void client.start().catch(() => {})
  const restart = client.restart()
  const result = expect(restart).rejects.toThrow('shutdown unconfirmed')
  await vi.advanceTimersByTimeAsync(3500)
  await result
  expect(launcher.spawn).toHaveBeenCalledTimes(1)
  expect(client.pid).toBe(123)
}, 2000)
