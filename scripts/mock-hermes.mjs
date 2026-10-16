// Synthetic contract fixtures only. Never represents a live Hermes response.
import { createServer } from 'node:http'
export async function startMock({ port = 0, delay = 30, key = 'orb-mock-only', prefix = '' } = {}) {
  const sessions = new Map(), runs = new Map(), requests = [], titles = new Set()
  let next = 0
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    requests.push({ method: req.method, path: req.url, body, headers: req.headers })
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (prefix && !req.url.startsWith(prefix + '/')) return json(404, { error: 'unknown_profile' })
    if (prefix) req.url = req.url.slice(prefix.length)
    if (req.url === '/health') return json(200, { status: 'ok', mock: true })
    if (req.headers.authorization !== `Bearer ${key}`) return json(401, { error: 'unauthorized' })
    if (req.url === '/api/sessions' && req.method === 'POST') {
      if (body.title && titles.has(body.title)) return json(400, { error: { code: 'invalid_title', message: 'Session title already in use' } })
      if (body.title) titles.add(body.title)
      const id = `mock-session-${++next}`; sessions.set(id, [])
      return json(201, { object: 'hermes.session', session: { id } })
    }
    if (req.url.startsWith('/api/sessions/') && req.method === 'GET') {
      const id = decodeURIComponent(req.url.split('/').pop())
      return json(200, { object: 'hermes.session', session: { id, messages: sessions.get(id) } })
    }
    if (req.url === '/v1/runs' && req.method === 'POST') {
      const idem = req.headers['idempotency-key']
      if (!idem) return json(400, { error: 'missing_idempotency_key' })
      const existing = [...runs.values()].find(r => r.idem === idem)
      if (existing) return json(JSON.stringify(existing.body) === raw ? 202 : 409, { run_id: existing.id, status: existing.status, replayed: true })
      const id = `mock-run-${++next}`, history = sessions.get(body.session_id)
      if (!history) return json(404, { error: 'missing_session' })
      const output = body.input === 'echo-secret' ? `MOCK secret: ${key}` : body.input === 'follow up' ? `MOCK context: ${history[0]?.text ?? 'none'}` : `MOCK answer: ${body.input}`
      history.push({ role: 'user', text: body.input })
      runs.set(id, { id, idem, body, status: 'queued', output, stopped: false, frames: [], clients: new Set(), connections: 0, decisions: [] })
      return json(202, { run_id: id, status: 'queued', replayed: false })
    }
    const match = /^\/v1\/runs\/([^/]+)(?:\/(events|stop|approval))?$/.exec(req.url)
    const run = match && runs.get(match[1])
    if (!run) return json(404, { error: 'not_found' })
    if (match[2] === 'approval') {
      if (req.method !== 'POST' || Object.keys(body).length !== 2 || !['once', 'deny'].includes(body.choice) || body.request_id !== run.pendingApproval || !run.pendingApproval) return json(409, { error: 'no_matching_approval' })
      run.decisions.push({ ...body }); run.decision = body.choice; run.pendingApproval = undefined
      return json(200, { object: 'hermes.run.approval_response', run_id: run.id, ...body, resolved: 1 })
    }
    if (match[2] === 'stop') { run.stopped = true; if (run.body.input === 'disconnect') run.status = 'cancelled'; return json(200, { run_id: run.id, status: 'stopping' }) }
    if (!match[2]) return json(200, { run_id: run.id, status: run.status, output: run.output })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': open\r\n\r\n')
    run.connections++
    for (const frame of run.frames) res.write(frame)
    if (run.finished) { res.end(); return }
    run.clients.add(res); res.on('close', () => run.clients.delete(res))
    if (run.producing) { if (run.body.input === 'disconnect') res.end(); return }
    run.producing = true
    const emit = async (event, fields = {}) => {
      await new Promise(r => setTimeout(r, delay))
      const n = run.frames.length + 1
      const frame = `id: ${n}\r\ndata: ${JSON.stringify({ event, run_id: run.id, timestamp: Date.now() / 1000, seq: n, ...fields })}\r\n\r\n`
      run.frames.push(frame)
      // Split every fixture frame across HTTP writes, including data JSON.
      for (const client of run.clients) { client.write(frame.slice(0, 13)); client.write(frame.slice(13)) }
    }
    const end = () => { run.finished = true; for (const client of run.clients) client.end() }
    run.status = 'running'
    await emit('tool.started', { tool: 'mock_clock', preview: 'Synthetic read-only tool' })
    if (run.body.input === 'disconnect') { res.end(); return }
    if (run.body.input.startsWith('approval')) {
      const rounds = run.body.input === 'approval-race' ? 2 : 1
      for (let round = 0; round < rounds && !run.stopped; round++) {
        const request_id = `mock-approval-${run.id}${round ? '-second' : ''}`
        run.pendingApproval = request_id; run.decision = undefined
        await emit('approval.request', { request_id, command: run.body.input === 'approval-echo-secret' ? `Synthetic blocked command ${key}` : 'Synthetic blocked command (NO real tools)', choices: ['once', 'session', 'always', 'deny'] })
        if (run.body.input === 'approval-reconnect') res.end()
        const deadline = Date.now() + (run.body.input === 'approval-timeout' ? 80 : 10_000)
        while (!run.stopped && !run.decision && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
        if (run.stopped) break
        if (!run.decision) { run.pendingApproval = undefined; run.status = 'failed'; await emit('run.failed'); end(); return }
        await emit('approval.responded', { request_id, choice: run.decision, resolved: 1 })
        if (run.decision === 'deny') { run.status = 'cancelled'; await emit('run.cancelled'); end(); return }
      }
    }
    if (run.body.input === 'slow') await new Promise(r => setTimeout(r, 800))
    if (run.stopped) { run.pendingApproval = undefined; run.status = 'cancelled'; await emit('run.cancelled'); end(); return }
    await emit('tool.completed', { tool: 'mock_clock', duration: .1 })
    if (run.body.input === 'fail') { run.status = 'failed'; await emit('run.failed', { error: 'Synthetic failure' }); end(); return }
    const split = run.body.input === 'echo-secret' ? 18 : 8
    await emit('message.delta', { delta: run.output.slice(0, split) })
    await emit('message.delta', { delta: run.output.slice(split) })
    await emit('message.interim', { text: run.output, already_streamed: true })
    run.status = 'completed'; historyAnswer(run)
    await emit('run.completed', { output: run.output }); end()
  })
  function historyAnswer(run) { sessions.get(run.body.session_id).push({ role: 'assistant', text: run.output }) }
  await new Promise(r => server.listen(port, '127.0.0.1', r))
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests, sessions, runs, close: () => new Promise(r => { server.close(r); server.closeAllConnections() }) }
}
if (process.argv[1]?.endsWith('mock-hermes.mjs')) {
  const mock = await startMock({ port: Number(process.argv[2] || 18642), delay: 180 })
  console.log(`Synthetic Hermes mock listening at ${mock.endpoint}; no real agent/tools`)
}
