import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { HermesClient } from './hermes-client'

// Relevant fields read from Megan's authenticated /v1/capabilities on October 14.
// This is a production contract snapshot, not a promise of mandatory consent.
const installedCapabilities = {
  object: 'hermes.api_server.capabilities',
  runtime: { mode: 'server_agent', tool_execution: 'server', split_runtime: false },
  features: { run_submission: true, run_approval_response: true, approval_events: true, run_events_sse: true }
}

test('normal production-shaped Megan run submits under backend policy without strict negotiation', async () => {
  const requests: { path: string; method: string }[] = []
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    requests.push({ path, method: init?.method ?? 'GET' })
    if (path.endsWith('/v1/capabilities')) return Response.json(installedCapabilities)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-test-key')
    expect(path.startsWith('/p/megan/')).toBe(true)
    if (path.endsWith('/api/sessions')) return Response.json({ session: { id: 'megan-session' } }, { status: 201 })
    if (path.endsWith('/api/sessions/megan-session')) return Response.json({ session: { id: 'megan-session' } })
    expect(JSON.parse(String(init?.body))).toEqual({ input: 'ordinary text', session_id: 'megan-session' })
    return Response.json({ run_id: 'normal-megan-run', status: 'started' }, { status: 202 })
  }
  const client = new HermesClient('http://127.0.0.1:8642/p/megan', 'private-test-key', transport)
  await expect(client.start('ordinary text')).resolves.toBe('normal-megan-run')
  expect(requests).toEqual([
    { path: '/p/megan/api/sessions', method: 'POST' },
    { path: '/p/megan/api/sessions/megan-session', method: 'GET' },
    { path: '/p/megan/v1/runs', method: 'POST' }
  ])
  client.resetSession()
  await expect(client.start('ordinary text')).resolves.toBe('normal-megan-run')
})

test.each([
  ['http://127.0.0.1:8642/p/megan', 'orb-mock-only'],
  ['http://127.0.0.1:18642', 'private-test-key']
])('synthetic opt-in refuses a production port or non-fixture key: %s', (endpoint, key) => {
  expect(() => new HermesClient(endpoint, key, fetch, true)).toThrow('Synthetic client requires isolated fixture credentials and port')
})

test('synthetic admission is limited to unpackaged mock or isolated UI-preview launches', () => {
  const main = readFileSync('src/main/index.ts', 'utf8')
  expect(main).toContain("const uiPreview = !app.isPackaged && process.env.ORB_UI_PREVIEW === '1'")
  expect(main).toContain("const mock = !app.isPackaged && (process.argv.includes('--mock-hermes') || uiPreview)")
  expect(main).toContain("mock ? new HermesClient('http://127.0.0.1:18642', 'orb-mock-only', fetch, true)")
  expect(main).toContain('new HermesClient(settings.endpoint, settings.key, fetch, false)')
})
