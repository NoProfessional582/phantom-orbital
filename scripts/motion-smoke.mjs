// Live scene probe in the existing local gallery; creates only synthetic orbs.
// No runtime changes to app code; scene interception is restored immediately.
import assert from 'node:assert/strict'
const pages=await(await fetch('http://127.0.0.1:9334/json')).json()
const page=pages.find(p=>p.type==='page'&&p.url.includes('gallery.html'))
assert.ok(page,'Project gallery missing')
const ws=new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j})
let id=0;const pending=new Map()
ws.onmessage=e=>{const v=JSON.parse(e.data),p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(v.error):p.resolve(v.result)}}
const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})
const evaluate=async expression=>{
  const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})
  assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value
}
const source=await(await fetch('http://localhost:5173/orb.ts')).text()
const three=source.match(/from\s+["']([^"']*three[^"']*)["']/)?.[1]
assert.ok(three,'Served Three module import missing')
try{
  await call('Page.reload');await new Promise(r=>setTimeout(r,1000));await call('Page.bringToFront')
  console.log('motion setup',await evaluate(`(async()=>{
    const T=await import(${JSON.stringify(three)}), {createOrb}=await import('/orb.ts');
    window.__motionProbes=[];
    for(const state of ['idle','muted','offline','speaking']){
      let scene;const add=T.Object3D.prototype.add;
      T.Object3D.prototype.add=function(...objects){if(this.isScene)scene=this;return add.apply(this,objects)};
      const host=document.createElement('div');host.style.cssText='position:fixed;left:0;top:0;width:320px;height:320px';document.body.append(host);
      let orb;try{orb=createOrb(host,{initial:state,level:1})}finally{T.Object3D.prototype.add=add}
      if(!scene)throw Error('Scene capture missing for '+state);
      window.__motionProbes.push({state,scene,orb,host,frames:[]});
    }
    window.__motionSample=()=>{
      for(const p of window.__motionProbes){
        const globe=p.scene.children.find(o=>o.type==='Group'&&o.children.some(c=>c.geometry?.parameters?.radius===.14));
        const core=globe.children.find(c=>c.geometry?.parameters?.radius===.14),halo=p.scene.children.find(o=>o.geometry?.parameters?.width===2.5);
        const ring=p.scene.children.find(o=>o.type==='Group'&&o!==globe),fabric=p.scene.children.filter(o=>o.material?.uniforms?.hemisphere);
        const u=core.material.uniforms;
        p.frames.push({t:performance.now(),spin:globe.rotation.y,orbit:ring.rotation.y,highlight:ring.children[0].material.uniforms.time.value,
          wave:fabric[0].material.uniforms.time.value,pulse:fabric[0].material.uniforms.pulse.value,scale:globe.scale.x,core:u.strength.value,saturation:u.saturation.value,gain:u.brightness.value,white:u.whiteness.value,
          halo:halo.material.uniforms.strength.value,haloGain:halo.material.uniforms.brightness.value,offset:core.getWorldPosition(new T.Vector3()).toArray(),visible:fabric.filter(o=>o.visible).length,rotation:fabric.map(o=>o.rotation.y)});
      }
    };await new Promise(r=>setTimeout(r,250));window.__motionSample();return window.__motionProbes.map(p=>p.state)
  })()`))
  // CDP-driven sampling is bounded even if native RAF is hidden/throttled.
  for(let i=0;i<65;i++){await new Promise(r=>setTimeout(r,100));await evaluate('window.__motionSample()')}
  const probes=await evaluate('window.__motionProbes.map(p=>({state:p.state,frames:p.frames}))')
  for(const {state,frames} of probes){
    const a=frames[0],b=frames.at(-1),seconds=(b.t-a.t)/1000,rate=state==='offline'?.5:1
    const spin=(b.spin-a.spin)/seconds,orbit=(b.orbit-a.orbit)/seconds,highlight=(b.highlight-a.highlight)/seconds
    // Real RAF cadence/initial warmup has one-frame phase error; bound by 5%.
    assert.ok(Math.abs(spin-.4*rate)<.02,`${state}: spin ${spin}`)
    assert.ok(Math.abs(orbit+2.4*rate)<.12,`${state}: orbit ${orbit}`)
    assert.ok(Math.abs(highlight+.135*rate)<.007,`${state}: highlight ${highlight}`)
    assert.ok(b.wave>a.wave);assert.ok(frames.every(f=>f.rotation.every(v=>v===0)))
    assert.ok(frames.every(f=>f.offset.every(v=>v===0)))
    assert.ok(frames.every(f=>f.scale===a.scale))
    assert.equal(b.visible,state==='offline'?0:6)
    assert.equal(b.gain,state==='offline'?2.1:2.5);assert.equal(b.white,state==='offline'?0:1)
    assert.equal(b.saturation,state==='offline'?.60:1)
    if(state!=='speaking')assert.ok(frames.every(f=>f.core===(state==='offline'?.30:.85)))
    if(state==='speaking'){assert.ok(Math.max(...frames.map(f=>f.core))>1.09);assert.ok(Math.max(...frames.map(f=>f.pulse))>.11)}
    console.log('live motion PASS',JSON.stringify({state,frames:frames.length,seconds,spin,orbit,highlight,visible:b.visible,coreRange:[Math.min(...frames.map(f=>f.core)),Math.max(...frames.map(f=>f.core))],scale:b.scale}))
  }
}finally{
  await call('Page.reload');await new Promise(r=>setTimeout(r,1000))
  console.log('motion demo restored',await evaluate(`(()=>{const s=document.querySelector('input');s.value='1';s.dispatchEvent(new Event('input'));return {canvases:document.querySelectorAll('canvas').length,probes:!!window.__motionProbes,level:s.value}})()`))
  ws.close()
}
