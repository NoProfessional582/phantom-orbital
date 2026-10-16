// Synthetic approvals only. Owns a mock and explicitly synthetic Electron app.
// Refuses occupied test ports; never submits to a live Hermes gateway or mic.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { startMock } from './mock-hermes.mjs'
const wait = ms => new Promise(r => setTimeout(r, ms))
const raceRepetitions = Number(process.argv.find(a => a.startsWith('--race-repetitions='))?.split('=')[1] ?? 3)
assert.ok(Number.isInteger(raceRepetitions) && raceRepetitions >= 1 && raceRepetitions <= 10, 'Bound race repetitions to 1–10')
async function vacant(port) {
  try { await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(500) }) }
  catch { return }
  throw new Error(`Test port ${port} already occupied; quit the existing preview manually first.`)
}
for (const port of [9335, 9230, 18642]) await vacant(port)
const mock = await startMock({ port: 18642, delay: 60 })
const child = spawn(resolve('node_modules/electron/dist/electron.exe'), [resolve('.'), '--mock-hermes', '--voice-smoke', '--remote-debugging-port=9335', '--inspect=9230'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: false })
let ws, mainWs, exited = false, mockClosed = false
child.on('exit', () => { exited = true })
const pending = new Map(), errors = []
let id = 0
async function page(port) {
  for (let n = 0; n < 150; n++) {
    try { const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (pages.length) return pages }
    catch {}
    await wait(100)
  }
  throw new Error(`No debugger target on ${port}`)
}
const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })) })
const evaluate = async expression => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value }
async function until(expression, timeout = 15000) {
  const end = Date.now() + timeout
  do { if (await evaluate(expression)) return; await wait(30) } while (Date.now() < end)
  throw new Error(`Timed out: ${expression}; snapshot ${JSON.stringify(await evaluate('window.__p4Snapshot'))}`)
}
async function click(selector) {
  const box = await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.hidden||b.disabled)throw new Error('Control unavailable');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box })
}
async function submit(text) {
  await until('!window.__p4Snapshot.busy')
  await evaluate(`window.orb.submit(${JSON.stringify(text)})`)
  await until('window.__p4Snapshot.busy')
}
async function approval() { await until('!!window.__p4Snapshot.approval'); return await evaluate('window.__p4Snapshot.approval') }
async function terminal() { await until('!window.__p4Snapshot.busy') }
async function ps(args) {
  return await new Promise((resolve, reject) => {
    const process = spawn('powershell.exe', ['-NoProfile', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''; process.stdout.on('data', d => { output += d }); process.stderr.on('data', d => { output += d })
    process.on('error', reject); process.on('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(output)))
  })
}
const grants = () => mock.requests.filter(r => r.path.endsWith('/approval'))
async function traceMain() {
  const target = (await page(9230))[0]
  mainWs = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { mainWs.onopen = r; mainWs.onerror = j })
  let serial = 0
  const jobs = new Map()
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++serial; jobs.set(n, { resolve, reject }); mainWs.send(JSON.stringify({ id: n, method, params }))
  })
  let paused
  const pause = new Promise(r => { paused = r })
  mainWs.onmessage = e => {
    const v = JSON.parse(e.data)
    if (v.method === 'Debugger.paused') paused(v.params.callFrames[0].callFrameId)
    const job = jobs.get(v.id)
    if (job) { jobs.delete(v.id); v.error ? job.reject(v.error) : job.resolve(v.result) }
  }
  await send('Debugger.enable')
  const lineNumber = readFileSync('out/main/index.js', 'utf8').split('\n').findIndex(l => l.includes('const card = snapshot.approval;'))
  assert.ok(lineNumber > 0)
  const bp = await send('Debugger.setBreakpointByUrl', { urlRegex: 'out[/\\\\]main[/\\\\]index\\.js$', lineNumber })
  const trigger = evaluate('window.orb.dismiss()')
  const callFrameId = await Promise.race([pause, wait(5000).then(()=>{throw new Error('Trace breakpoint not reached')})])
  const installed = await send('Debugger.evaluateOnCallFrame', { callFrameId, expression: `
    globalThis.__p4Trace=[];
    globalThis.__p4Blur=()=>win.blur();
    globalThis.__p4Capture=true;
    const record=(kind,data)=>{if(globalThis.__p4Capture&&globalThis.__p4Trace.length<4096)globalThis.__p4Trace.push({t:Date.now(),kind,...data})};
    const send=sidecar.send.bind(sidecar);
    sidecar.send=m=>{if(m.type==='approval-hotkey')record('eligibility',{card:m.card,enabled:m.enabled,focused:win.isFocused()});return send(m)};
    const receive=sidecar.receive.bind(sidecar);
    sidecar.receive=m=>{if(m.type==='approval-hotkey')record('physical-edge',{id:m.id,focused:win.isFocused(),card:chat.snapshot.approval?.id,pending:chat.snapshot.approval?.pending});return receive(m)};
    const decision=chat.respondApproval.bind(chat);
    chat.respondApproval=m=>{record('decision',{id:m.id,choice:m.choice});return decision(m)};
    true`, returnByValue: true })
  assert.ok(!installed.exceptionDetails, JSON.stringify(installed.exceptionDetails))
  await send('Debugger.removeBreakpoint', { breakpointId: bp.breakpointId })
  await send('Debugger.resume')
  await trigger
  await send('Debugger.disable')
  runMain = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true })
    assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value
  }
  return async () => (await send('Runtime.evaluate', { expression: 'globalThis.__p4Trace', returnByValue: true })).result.value
}
let readTrace, runMain
try {
  const target = (await page(9335)).find(p => p.type === 'page' && p.url.includes('index.html'))
  assert.ok(target)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = e => { const v = JSON.parse(e.data); if (v.method === 'Runtime.exceptionThrown') errors.push(v.params.exceptionDetails); const p = pending.get(v.id); if (p) { pending.delete(v.id); v.error ? p.reject(v.error) : p.resolve(v.result) } }
  await call('Runtime.enable')
  await until("document.getElementById('app').dataset.synthetic==='true'")
  assert.equal(await evaluate("document.getElementById('app').dataset.syntheticAudio==='true'"), true)
  await evaluate('window.__p4Off=window.orb.onChat(s=>window.__p4Snapshot=s);window.orb.dismiss()')
  await until('window.__p4Snapshot?.voice?.ready')
  assert.equal(await evaluate('window.__p4Snapshot.voice.enabled'), false)
  assert.equal(await evaluate('window.__p4Snapshot.approvalShortcutAvailable'), true, 'registration conflict/readiness check before injecting Y')
  assert.equal(await evaluate('Object.keys(window.orb).some(k=>/token|key|credential|endpoint/i.test(k))'), false)
  readTrace = await traceMain()

  await submit('approval')
  const first = await approval()
  await evaluate("document.querySelector('[data-action=approve-once]').click()")
  await wait(120)
  assert.equal(grants().length, 0, 'programmatic clicks are not user consent')
  await click('[data-action=approve-once]'); await terminal()
  assert.deepEqual(grants()[0].body, { choice: 'once', request_id: `mock-approval-${grants()[0].path.split('/')[3]}` })
  await evaluate(`window.orb.approval(${JSON.stringify(first.id)},'once')`); await wait(50)
  assert.equal(grants().length, 1, 'stale card cannot issue another grant')

  await submit('approval'); await approval(); await click('[data-action=deny]'); await terminal()
  assert.equal(grants()[1].body.choice, 'deny')
  await submit('approval-timeout'); const expired = await approval(); await terminal()
  await evaluate(`window.orb.approval(${JSON.stringify(expired.id)},'once')`); await wait(50)
  assert.equal(grants().length, 2)

  await submit('approval-reconnect'); const replay = await approval(); await wait(160)
  assert.equal(await evaluate('window.__p4Snapshot.approval.id'), replay.id)
  await click('[data-action=approve-once]'); await terminal()
  assert.equal([...mock.runs.values()].at(-1).connections, 2)

  for (let repetition = 1; repetition <= raceRepetitions; repetition++) {
    await runMain('globalThis.__p4Trace=[]')
    await submit('approval-race'); const held = await approval()
    // Regression: lose foreground before launching the native injector.
    // Fixture setup must refocus only its synthetic window, with keys released.
    await runMain('globalThis.__p4Blur()')
    const native = await ps(['-ExecutionPolicy', 'Bypass', '-File', 'scripts/voice-native-smoke.ps1', '-Approval', '-HoldMs', '1400'])
    await until(`window.__p4Snapshot.approval && window.__p4Snapshot.approval.id!==${JSON.stringify(held.id)}`)
    const second = await approval(), race = [...mock.runs.values()].at(-1), trace = await readTrace()
    const down = Number(/NATIVE down t=(\d+)/.exec(native)?.[1]), up = Number(/NATIVE up t=(\d+)/.exec(native)?.[1])
    assert.ok(down < up)
    assert.match(native, /state=32768\/32768\/32768/)
    assert.equal(/state=(?!32768\/32768\/32768)[\d/]+/.test(native), false, 'Chord never released during hold')
    assert.ok(trace.some(e => e.kind === 'eligibility' && e.card === second.id && e.t > down && e.t < up), 'Second card became eligible while the first chord remained held')
    assert.deepEqual(trace.filter(e => e.kind === 'physical-edge').map(e => e.id), [held.id], 'One physical edge, correlated only to the first card')
    assert.deepEqual(race.decisions, [{ choice: 'once', request_id: `mock-approval-${race.id}` }])
    await click('[data-action=deny]'); await terminal()
    assert.deepEqual(race.decisions, [{ choice: 'once', request_id: `mock-approval-${race.id}` }, { choice: 'deny', request_id: `mock-approval-${race.id}-second` }])
    console.log('HELD CARD PASS', JSON.stringify({ repetition, native, main: await readTrace(), run: race.id, decisions: race.decisions }))
  }
  await runMain('globalThis.__p4Capture=false')

  const priorSession = [...mock.runs.values()].at(-1).body.session_id
  await submit('approval'); const cancelled = await approval()
  await click('.session-controls button'); await terminal()
  assert.equal(await evaluate('window.__p4Snapshot.notice'), 'New conversation.')
  await evaluate(`window.orb.approval(${JSON.stringify(cancelled.id)},'once')`)
  await submit('follow up'); await terminal()
  assert.equal(await evaluate('window.__p4Snapshot.answer'), 'MOCK context: none')
  assert.notEqual([...mock.runs.values()].at(-1).body.session_id, priorSession)

  await submit('slow'); await until("window.__p4Snapshot.state==='working'"); await click('[data-action=stop]'); await terminal()
  await submit('disconnect'); await until("window.__p4Snapshot.state==='offline'")
  const recovered = [...mock.runs.values()].at(-1); recovered.status = 'completed'; recovered.output = 'Synthetic status recovery'
  await click('.session-controls button:nth-child(2)'); await terminal()
  assert.equal(await evaluate('window.__p4Snapshot.answer'), 'Synthetic status recovery')

  // Kill ONLY the owned synthetic Python worker, never a service or other profile.
  const processes = JSON.parse(await ps(['-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "python.exe" -and $_.CommandLine -like "*hermes-orb*server.py*--synthetic-smoke*" } | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress']))
  const all = Array.isArray(processes) ? processes : [processes]
  const leaf = all.find(p => all.some(parent => parent.ProcessId === p.ParentProcessId)) ?? all[0]
  assert.ok(leaf?.ProcessId)
  process.kill(leaf.ProcessId)
  await until('!window.__p4Snapshot.voice.ready')
  assert.equal(await evaluate('window.__p4Snapshot.voice.enabled'), false)
  await click('.session-controls button:nth-child(3)')
  await until('window.__p4Snapshot.voice.ready')
  assert.equal(await evaluate('window.__p4Snapshot.voice.enabled'), false)
  assert.equal(await evaluate('window.__p4Snapshot.voice.level'), 0)
  assert.deepEqual(errors, [])
  assert.equal(await evaluate("!!document.querySelector('canvas').getContext('webgl2')"), true)
  assert.ok(grants().every(r => Object.keys(r.body).length === 2 && ['once', 'deny'].includes(r.body.choice)))
  console.log(JSON.stringify({ result: 'PASS', syntheticOnly: true, appPid: child.pid, approvalRequests: grants().map(r => ({ run: r.path.split('/')[3], ...r.body })), sessions: mock.sessions.size, runs: mock.runs.size, raceRepetitions, nativeHeldApprovalEdge: true, sidecarWorkerKilled: leaf.ProcessId, sidecarRestartMicOff: true }))
  await evaluate('window.orb.newConversation();window.orb.dismiss();window.__p4Off()')
  if (process.argv.includes('--voice')) {
    await wait(150)
    await mock.close(); mockClosed = true
    await new Promise((resolve, reject) => {
      const voice = spawn(process.execPath, ['scripts/voice-smoke.mjs', '9335'], { stdio: ['ignore', 'pipe', 'pipe'] })
      voice.stdout.on('data', d => process.stdout.write(d)); voice.stderr.on('data', d => process.stderr.write(d))
      voice.on('error', reject); voice.on('exit', code => code === 0 ? resolve() : reject(new Error(`Synthetic voice smoke exit ${code}`)))
    })
  }
} finally {
  if (readTrace) console.log('APPROVAL TRACE', JSON.stringify({ main: await readTrace(), mock: [...mock.runs.values()].filter(r=>r.body.input==='approval-race').map(r=>({id:r.id,status:r.status,decisions:r.decisions,events:r.frames.map(f=>JSON.parse(f.split('data: ')[1]))})) }))
  mainWs?.close()
  ws?.close()
  if (!mockClosed) await mock.close()
  // Inspector exists only on this owned synthetic process, for graceful teardown.
  try {
    const target = (await page(9230))[0]
    mainWs = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((r, j) => { mainWs.onopen = r; mainWs.onerror = j })
    mainWs.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "process.mainModule.require('electron').app.quit()" } }))
    for (let n = 0; n < 30 && !exited; n++) await wait(100)
  } catch {}
  mainWs?.close()
  if (!exited) { child.kill(); for (let n = 0; n < 20 && !exited; n++) await wait(100) }
  assert.equal(exited, true, 'owned synthetic app exited')
}
