// Synthetic-input acceptance only: actual Windows chord, local models/output,
// authenticated sidecar, existing Electron gateway client and an HTTP/SSE mock.
// Never capture microphone audio or contact the real gateway in this script.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { startMock } from './mock-hermes.mjs'
const port = process.argv[2] || '9335'
const mock = await startMock({ port: 18642, delay: 60 })
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = pages.find(p => p.type === 'page' && p.url.includes('index.html'))
assert.ok(page)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r,j) => { ws.onopen=r; ws.onerror=j })
let id=0, syntheticVerified=false; const pending=new Map(), errors=[]
ws.onmessage=e=>{const v=JSON.parse(e.data);if(v.method==='Runtime.exceptionThrown')errors.push(v.params.exceptionDetails);const p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(v.error):p.resolve(v.result)}}
const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})
const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value}
const wait=ms=>new Promise(r=>setTimeout(r,ms))
async function until(expression, timeout=90000) { const end=Date.now()+timeout; do { if(await evaluate(expression))return; await wait(25) } while(Date.now()<end); assert.fail(`Timed out: ${expression}`) }
async function chord(mute=false) {
  await new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/voice-native-smoke.ps1',...(mute?['-Mute']:[])],{stdio:['ignore','pipe','pipe'],windowsHide:true})
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(output)))
  })
}
try {
  await call('Runtime.enable')
  assert.equal(await evaluate("document.getElementById('app').dataset.syntheticAudio==='true'"), true, 'Refuse all voice controls unless input is explicitly synthetic')
  syntheticVerified=true
  await evaluate(`window.__voiceEvents=[];window.__voiceOff=window.orb.onChat(s=>{window.__voiceSnapshot=s;window.__voiceEvents.push({t:performance.now(),state:s.state,voice:s.voice})})`)
  // Publish a fresh snapshot without beginning any recording.
  await evaluate(`window.orb.dismiss()`)
  await until(`window.__voiceSnapshot?.voice?.ready`,15000)
  const capabilities=await evaluate(`window.__voiceSnapshot.voice`)
  assert.equal(capabilities.hotkeyAvailable,true,'main owns Ctrl+Shift+Space before injection')
  assert.equal(capabilities.muteShortcutAvailable,true,'Ctrl+Alt+M reservation verified before injection')
  await evaluate(`window.orb.voiceMode()`)
  await until(`window.__voiceSnapshot.voice.enabled`)
  // Exercise the accessible Hold button, then discard without any transcript/run.
  await evaluate(`[...document.querySelectorAll('.orb-controls button')].find(b=>b.textContent==='Hold').dispatchEvent(new KeyboardEvent('keydown',{code:'Space',bubbles:true}))`)
  await until(`window.__voiceSnapshot.voice.state==='listening'`)
  await evaluate(`window.orb.stop()`)
  await until(`window.__voiceSnapshot.voice.state==='idle'`)
  const results=[]
  for(let round=0;round<2;round++) {
    await evaluate(`window.__voiceEvents=[]`)
    await chord()
    await until(`window.__voiceEvents.some(e=>e.voice.state==='listening')`)
    await until(`window.__voiceEvents.some(e=>e.voice.state==='transcribing')`)
    await until(`window.__voiceEvents.some(e=>e.voice.state==='speaking'&&e.voice.level>0)`)
    // A second physical hold during playback must not open the microphone.
    await evaluate(`window.__voiceEventsDuringPlayback=[];window.__voicePlaybackOff=window.orb.onChat(s=>window.__voiceEventsDuringPlayback.push(s.voice.state))`)
    await chord()
    await until(`window.__voiceSnapshot.voice.state==='idle' && !window.__voiceSnapshot.busy`)
    assert.equal(await evaluate(`window.__voiceEventsDuringPlayback.includes('listening')`),false)
    await evaluate(`window.__voicePlaybackOff()`)
    const events=await evaluate(`window.__voiceEvents`)
    const release=events.find(e=>e.voice.state==='transcribing')
    const first=events.find(e=>e.voice.state==='speaking'&&e.voice.level>0)
    const snapshot=await evaluate(`window.__voiceSnapshot`)
    assert.match(snapshot.user,/amber orbit/i,'real local Whisper decoded the Piper-generated fixture')
    assert.equal(snapshot.answer,`MOCK answer: ${snapshot.user}`)
    assert.equal(snapshot.voice.device,'cuda','actual CUDA transcription completed, not only configured')
    const latency=Math.round(first.t-release.t)
    results.push({round:round+1,releaseToFirstOutputLevelMs:latency,device:snapshot.voice.device})
    console.log('SYNTHETIC native PTT -> VAD/Whisper -> main/mock HTTP/SSE -> Amy/output',JSON.stringify(results.at(-1)))
  }
  await chord(true)
  await until(`window.__voiceSnapshot.voice.muted`)
  await evaluate(`window.__voiceEvents=[]`)
  await chord()
  await wait(200)
  assert.equal(await evaluate(`window.__voiceEvents.some(e=>e.voice.state==='listening')`),false)
  await chord(true)
  await until(`!window.__voiceSnapshot.voice.muted`)
  const requests=mock.requests.filter(r=>r.method==='POST'&&r.path==='/v1/runs')
  assert.equal(requests.length,2,'only two accepted fixture transcripts were submitted')
  assert.ok(requests.every(r=>typeof r.body.input==='string'))
  assert.equal(mock.sessions.size,1,'existing unique-title session reused')
  assert.deepEqual(errors,[])
  console.log('PASS: actual local Amy output, numeric levels, no listen during playback, native mute, no microphone capture; synthetic input/mock gateway only')
  console.log('Latency excludes real user articulation and real Hermes reasoning; first-output-level timestamp follows first sounddevice write, not acoustic measurement.')
} finally {
  if(syntheticVerified) await evaluate(`window.__voiceOff?.();window.__voicePlaybackOff?.();window.orb.stop();if(window.__voiceSnapshot?.voice?.enabled)window.orb.voiceMode();window.orb.dismiss()`)
  ws.close(); await mock.close()
}
