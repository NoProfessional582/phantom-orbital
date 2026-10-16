import assert from 'node:assert/strict'
const port = process.argv[2] || '9335'
const mode = process.argv[3] || 'mock'
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = pages.find(p => p.type === 'page' && p.url.includes('index.html'))
assert.ok(page, 'Native Orb page exists')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r,j) => { ws.onopen=r; ws.onerror=j })
let id=0; const pending=new Map(), errors=[]
ws.onmessage=e=>{const v=JSON.parse(e.data);if(v.method==='Runtime.exceptionThrown')errors.push(v.params.exceptionDetails);const p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(v.error):p.resolve(v.result)}}
const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})
const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value}
const wait=ms=>new Promise(r=>setTimeout(r,ms))
async function until(expression, timeout=6000) { const end=Date.now()+timeout; do { if(await evaluate(expression))return; await wait(40) } while(Date.now()<end); assert.fail(`Timed out: ${expression}`) }
try {
  await call('Runtime.enable')
  if (mode === 'mock') assert.equal(await evaluate("document.getElementById('app').dataset.synthetic==='true'"), true, 'Refuse synthetic prompts against a live gateway app')
  await evaluate(`window.__chatSmokeStates=[];window.__chatSmokeOff=window.orb.onChat(s=>{window.__chatSmokeStates.push(s.state);window.__chatSmokeSnapshot=s})`)
  assert.equal(await evaluate(`!!document.querySelector('.chat-input input')`),true,'Text input is installed')
  assert.equal(await evaluate(`typeof window.orb.submit`),'function')
  assert.equal(await evaluate(`Object.keys(window.orb).some(k=>/key|token|endpoint|credential/i.test(k))`),false)
  await evaluate(`window.orb.toggleInput()`)
  await until(`!document.querySelector('.chat-input').hidden`)
  assert.equal(await evaluate(`document.activeElement===document.querySelector('.chat-input input')`),true)
  async function submit(text) {
    await evaluate(`(()=>{window.__chatSmokeStates=[];const input=document.querySelector('.chat-input input');input.value=${JSON.stringify(text)};document.querySelector('.chat-input').requestSubmit()})()`)
    await until(`window.__chatSmokeStates.includes('thinking')`)
    console.log('observed thinking:',text)
  }
  if (mode === 'offline') {
    await submit('what time is it')
    await until(`document.getElementById('app').dataset.chatState==='offline'`,20000)
    assert.match(await evaluate(`document.querySelector('.captions .tool').textContent`),/unavailable/)
    console.log('real endpoint unavailable warning verified; no live answer claimed')
  } else {
    await submit('remember blue')
    await until(`document.getElementById('app').dataset.chatState==='working'`)
    await until(`document.querySelector('.reply').textContent==='MOCK answer: remember blue'`)
    await until(`document.getElementById('app').dataset.chatState==='idle'`)
    await submit('follow up')
    await until(`document.querySelector('.reply').textContent==='MOCK context: remember blue'`)
    await until(`document.getElementById('app').dataset.chatState==='idle'`)
    await submit('slow')
    await until(`document.getElementById('app').dataset.chatState==='working'`)
    await evaluate(`document.querySelector('[data-action="stop"]').click()`)
    await until(`document.querySelector('.tool').textContent==='Stopped.'`)
    assert.equal(await evaluate(`document.getElementById('app').dataset.busy`),'false')
    await submit('approval')
    await until(`!!window.__chatSmokeSnapshot?.approval`)
    await evaluate(`window.orb.approval(window.__chatSmokeSnapshot.approval.id,'deny')`)
    await until(`!window.__chatSmokeSnapshot.busy`)
    console.log('MOCK ONLY: thinking, working, final captions, same-session recall, Stop confirmation and synthetic denial verified')
  }
  assert.deepEqual(errors,[],'No renderer exceptions')
  assert.equal(await evaluate(`!!document.querySelector('canvas').getContext('webgl2')`),true)
  console.log('Native UI PASS; sandbox bridge, real WebGL and no uncaught errors')
} finally { await evaluate(`window.__chatSmokeOff?.();delete window.__chatSmokeOff;delete window.__chatSmokeStates`); ws.close() }
