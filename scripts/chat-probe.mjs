import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
const mode=process.argv[2] || 'snapshot'
const pages=await(await fetch('http://127.0.0.1:9335/json')).json()
const page=pages.find(p=>p.type==='page' && p.url.includes('index.html'))
assert.ok(page)
const ws=new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j})
let id=0; const pending=new Map()
ws.onmessage=e=>{const v=JSON.parse(e.data);const p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(v.error):p.resolve(v.result)}}
const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.ok(!r.exceptionDetails);return r.result.value}
try {
  if(mode==='prepare') { await evaluate(`(()=>{if(!document.querySelector('.chat-input').hidden)window.orb.toggleInput();window.orb.dismiss()})()`);await new Promise(r=>setTimeout(r,400)) }
  const state=await evaluate(`({open:!document.querySelector('.chat-input').hidden,answer:document.querySelector('.reply').textContent,state:document.getElementById('app').dataset.chatState,busy:document.getElementById('app').dataset.busy,canvas:[document.querySelector('canvas').width,document.querySelector('canvas').height],textCenter:(()=>{const r=[...document.querySelectorAll('.orb-controls button')].find(b=>b.textContent==='Text').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})(),inputBounds:(()=>{const r=document.querySelector('input').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()})`)
  if(mode==='open')assert.equal(state.open,true)
  if(mode==='closed')assert.equal(state.open,false)
  if(mode==='native-answer') {assert.equal(state.answer,'MOCK answer: native keyboard');assert.equal(state.busy,'false')}
  if(mode==='capture'){const shot=await call('Page.captureScreenshot',{format:'png'});writeFileSync('.orchestra/previews/chat-functional.png',Buffer.from(shot.data,'base64'))}
  console.log(JSON.stringify(state))
}finally{ws.close()}
