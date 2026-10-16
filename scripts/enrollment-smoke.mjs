// Focused M5 control smoke: synthetic mic replacement and mock Hermes ONLY.
// No physical mic or live gateway use, no audio writes or audio upload.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { startMock } from './mock-hermes.mjs'
const port = process.argv[2] || '9335'
const mock = await startMock({ port: 18642, delay: 60 })
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = pages.find(p => p.type === 'page' && p.url.includes('index.html'))
assert.ok(page)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let id = 0, syntheticVerified = false
const pending = new Map(), errors = []
ws.onmessage = e => {
  const v = JSON.parse(e.data)
  if (v.method === 'Runtime.exceptionThrown') errors.push(v.params.exceptionDetails)
  if (v.method === 'Page.javascriptDialogOpening') {
    assert.ok(syntheticVerified, 'Never consent on a real mic instance')
    void call('Page.handleJavaScriptDialog', { accept: true })
  }
  const p = pending.get(v.id)
  if (p) { pending.delete(v.id); v.error ? p.reject(v.error) : p.resolve(v.result) }
}
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params }))
})
const evaluate = async expression => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(expression, timeout = 90000) {
  const end = Date.now() + timeout
  do { if (await evaluate(expression)) return; await wait(50) } while (Date.now() < end)
  assert.fail(`Timed out: ${expression}; ${JSON.stringify(await evaluate('window.__m5'))}`)
}
async function click(selector) {
  const p = await evaluate(`(()=>{const b=${selector};const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,disabled:b.disabled}})()`)
  assert.equal(p.disabled, false)
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
}
const control = name => `[...document.querySelectorAll('.orb-controls button')].find(b=>b.textContent===${JSON.stringify(name)})`
const enroll = `[...document.querySelectorAll('.session-controls button')].find(b=>/^(Enroll voice|Re-enroll voice)$/.test(b.textContent))`
async function holdRelease() {
  await evaluate(`${control('Hold')}.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',bubbles:true}))`)
  await until(`window.__m5.voice.state==='listening'`)
  await evaluate(`${control('Hold')}.dispatchEvent(new KeyboardEvent('keyup',{code:'Space',bubbles:true}))`)
  await until(`window.__m5.voice.state==='idle' && !window.__m5.busy`)
  await wait(100)
}
try {
  await call('Runtime.enable'); await call('Page.enable')
  assert.equal(await evaluate("document.getElementById('app').dataset.syntheticAudio==='true'"), true)
  syntheticVerified = true
  await evaluate(`window.__m5Off=window.orb.onChat(s=>window.__m5=s);window.orb.dismiss()`)
  await until(`window.__m5?.voice?.ready`, 15000)
  assert.equal(await evaluate(`window.__m5.voice.enabled`), false)
  await click(control('Voice'))
  await until(`window.__m5.voice.enabled`)
  await click(enroll)
  await until(`window.__m5.voice.enrolling`)
  for (let i = 1; i <= 6; i++) {
    await holdRelease()
    console.log('synthetic sample', i, await evaluate('window.__m5.voice.notice'))
    if (i < 6) {
      assert.equal(await evaluate(`window.__m5.voice.enrollmentCount`), i)
      assert.equal(await evaluate(`window.__m5.voice.enrolling`), true)
    }
    assert.equal(mock.requests.filter(r => r.method === 'POST' && r.path === '/v1/runs').length, 0, 'Enrollment never sends a run')
    assert.equal(await evaluate(`window.__m5.user`), '')
  }
  assert.equal(await evaluate(`window.__m5.voice.registered`), true)
  assert.equal(await evaluate(`window.__m5.voice.enrolling`), false)
  const profilePath = '.cache/synthetic-voice/voice-profile.json'
  assert.ok(existsSync(profilePath))
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
  assert.equal(profile.sample_count, 6); assert.equal(profile.check_count, 2)
  assert.ok(!('audio' in profile) && !('transcript' in profile))
  await holdRelease()
  await until(`window.__m5.answer && !window.__m5.busy && window.__m5.voice.state==='idle'`)
  assert.match(await evaluate(`window.__m5.user`), /amber orbit/i)
  assert.equal(mock.requests.filter(r => r.method === 'POST' && r.path === '/v1/runs').length, 1)
  // Start another enrollment, then Voice off: no profile replacement or resumption.
  await click(enroll); await until(`window.__m5.voice.enrolling`)
  await click(control('Voice on')); await until(`!window.__m5.voice.enabled && !window.__m5.voice.enrolling`)
  assert.deepEqual(JSON.parse(readFileSync(profilePath, 'utf8')), profile)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'PASS', input: 'six distinct Amy-generated PTT fixtures; no mic',
    enrollmentRuns: 0, acceptedRuns: 1, profilePath, threshold: profile.threshold,
    device: await evaluate(`window.__m5.voice.device`), cancellation: 'Voice off discarded enrollment',
    humanSpeakerRejection: 'NOT TESTED; synthetic same voice is not human acceptance' }))
} finally {
  if (syntheticVerified) await evaluate(`window.orb.stop();if(window.__m5?.voice?.enabled)window.orb.voiceMode();window.__m5Off?.()`)
  ws.close(); await mock.close()
}
