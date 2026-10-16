// Local CDP smoke for the real built gallery; requires an existing gallery
// Electron demo with --remote-debugging-port=9334. Restores its original URL.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const port=process.argv[2] ?? '9334'
const pages=await(await fetch(`http://127.0.0.1:${port}/json`)).json()
const page=pages.find(p=>p.type==='page' && p.url.includes('gallery.html'))
assert.ok(page,'Existing project gallery target missing')
const ws=new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j})
let id=0
const pending=new Map(), errors=[]
ws.onmessage=e=>{
  const v=JSON.parse(e.data)
  if(v.method==='Runtime.exceptionThrown')errors.push(v.params.exceptionDetails)
  const p=pending.get(v.id)
  if(p){pending.delete(v.id);v.error?p.reject(v.error):p.resolve(v.result)}
}
const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})
const evaluate=async expression=>{
  const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})
  assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails))
  return r.result.value
}
const wait=ms=>new Promise(r=>setTimeout(r,ms))
const states=['idle','listening','transcribing','thinking','working','speaking','approval','offline','muted']
try{
  await call('Runtime.enable')
  await call('Page.navigate',{url:pathToFileURL(resolve('out/renderer/gallery.html')).href})
  await call('Page.bringToFront')
  await wait(1600)
  const inventory=await evaluate(`({url:location.href,canvases:document.querySelectorAll('canvas').length,tiles:document.querySelectorAll('.tile').length,states:[...document.querySelectorAll('select option')].map(o=>o.value),labels:[...document.querySelectorAll('.label')].map(o=>o.firstChild.textContent.toLowerCase()),contexts:[...document.querySelectorAll('canvas')].map(c=>!!c.getContext('webgl2'))})`)
  assert.equal(inventory.canvases,9);assert.equal(inventory.tiles,9)
  assert.deepEqual(inventory.states,states);assert.deepEqual(inventory.labels,states)
  assert.ok(inventory.contexts.every(Boolean),'A real gallery WebGL context failed')
  console.log('built gallery inventory',JSON.stringify(inventory))
  for(const state of states){
    const selected=await evaluate(`(()=>{const p=document.querySelector('select');p.value=${JSON.stringify(state)};p.dispatchEvent(new Event('change'));return p.value})()`)
    assert.equal(selected,state)
    await wait(180)
  }
  for(const level of ['0','1','.37']){
    assert.equal(await evaluate(`(()=>{const s=document.querySelector('input');s.value=${JSON.stringify(level)};s.dispatchEvent(new Event('input'));return Number(s.value)})()`),Number(level))
  }
  await call('Page.reload');await wait(1000) // restore all nine original tile states
  await evaluate(`(()=>{const s=document.querySelector('input');s.value='1';s.dispatchEvent(new Event('input'))})()`)
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:1400,deviceScaleFactor:1,mobile:false})
  for(const shade of ['dark','light']){
    if(shade==='light'){
      assert.equal(await evaluate(`(()=>{document.querySelector('button').click();return document.querySelectorAll('.tile.light').length})()`),9)
      assert.equal(await evaluate(`document.querySelector('button').textContent`),'Dark background')
    }
    await wait(500)
    const shot=await call('Page.captureScreenshot',{format:'png'})
    writeFileSync(`.orchestra/previews/approved-built-gallery-${shade}.png`,Buffer.from(shot.data,'base64'))
  }
  assert.equal(await evaluate(`(()=>{document.querySelector('button').click();return document.querySelectorAll('.tile.light').length})()`),0)
  const fps=await evaluate(`[...document.querySelectorAll('.fps')].map(e=>e.textContent)`)
  assert.ok(fps.every(s=>parseFloat(s)>0),'Real gallery animation did not draw frames')
  assert.deepEqual(errors,[],'Uncaught renderer errors')
  console.log('built gallery PASS: nine state-picker events, fake levels 0/1/.37, light/dark toggle, nine animated WebGL canvases; fps',fps)
}finally{
  await call('Emulation.clearDeviceMetricsOverride')
  await call('Page.navigate',{url:page.url})
  await wait(1000)
  const restored=await evaluate(`({url:location.href,canvases:document.querySelectorAll('canvas').length})`)
  assert.equal(restored.url,page.url);assert.equal(restored.canvases,9)
  await evaluate(`(()=>{const s=document.querySelector('input');s.value='1';s.dispatchEvent(new Event('input'))})()`)
  console.log('demo restored',JSON.stringify(restored))
  ws.close()
}
