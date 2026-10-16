// Test harness only. Isolated browser data, synthetic PCM, silent sample sink.
const { app, BrowserWindow, ipcMain, session } = require('electron')
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { join } = require('node:path')
const { mkdirSync } = require('node:fs')
const assert = require('node:assert/strict')
const root = process.argv[2], endpoint = process.argv[3]
assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/)
const cache = join(root,'.cache/m6-ui')
mkdirSync(join(cache,'browser'),{recursive:true})
app.setPath('userData',join(cache,'browser'))
app.setPath('sessionData',join(cache,'browser'))
const { VoiceController } = require(join(cache,'voice-controller.js'))
const { ChatController } = require(join(cache,'chat-controller.js'))
const { HermesClient } = require(join(cache,'hermes-client.js'))
let child, socket, win, voice
const events=[]
const wait = ms => new Promise(r=>setTimeout(r,ms))
async function until(fn, message, timeout=60000) {
  const end=Date.now()+timeout
  do { if(await fn()) return; await wait(20) } while(Date.now()<end)
  throw new Error(`${message}: ${JSON.stringify(voice?.snapshot)}`)
}
app.whenReady().then(async()=>{
  let exit=1, sink
  try {
    session.defaultSession.setPermissionRequestHandler((_w,_p,callback)=>callback(false))
    const token=randomBytes(32).toString('hex')
    child=spawn(join(root,'sidecar/.venv/Scripts/python.exe'),['-E','-s',join(root,'sidecar/tests/wake_ui_server.py')],{
      cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],
      env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,LOCALAPPDATA:process.env.LOCALAPPDATA,ORB_VOICE_TOKEN:token,HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1'}
    })
    child.stderr.on('data', d=>process.stderr.write(d))
    let text='', info
    child.stdout.on('data', d=>{ text+=d; let i; while((i=text.indexOf('\n'))>=0){const line=text.slice(0,i);text=text.slice(i+1);const v=JSON.parse(line);if(v.port)info=v;else sink=v} })
    await until(()=>info,'synthetic sidecar port')
    const client=new HermesClient(endpoint,'orb-mock-only',fetch,true)
    let chat
    const publish=()=>{if(win&&!win.isDestroyed())win.webContents.send('orb:chat',{...chat.snapshot,notice:chat.snapshot.notice||voice?.snapshot.notice||'',voice:voice?.snapshot,synthetic:true,syntheticAudio:true})}
    chat=new ChatController(client,s=>{voice?.chatChanged(s);publish()})
    socket=new WebSocket(`ws://127.0.0.1:${info.port}`)
    const send=m=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(m))}
    voice=new VoiceController(chat,send,publish)
    socket.onopen=()=>send({type:'auth',token})
    socket.onmessage=e=>{const m=JSON.parse(e.data);events.push(m);voice.receive(m)}
    win=new BrowserWindow({width:340,height:550,show:true,webPreferences:{preload:join(root,'out/preload/index.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}})
    for(const name of ['voice-mode','voice-activation','mute','stop','dismiss'])ipcMain.on(`orb:${name}`,e=>{
      if(e.sender!==win.webContents)return
      if(name==='voice-mode')voice.mode(!voice.snapshot.enabled)
      if(name==='voice-activation')voice.activation(!voice.snapshot.activation)
      if(name==='mute')voice.mute()
      if(name==='stop'){voice.stop();void chat.stop()}
      if(name==='dismiss')chat.dismiss()
    })
    await win.loadFile(join(root,'out/renderer/index.html'))
    await until(()=>voice.snapshot.ready,'ready')
    publish()
    const js=expression=>win.webContents.executeJavaScript(expression)
    const click=label=>js(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`)
    await until(()=>js(`document.getElementById('app').dataset.voiceReady==='true'`),'renderer ready')
    assert.equal(voice.snapshot.activation,false)
    await click('Voice')
    await until(()=>voice.snapshot.enabled&&voice.snapshot.registered,'synthetic profile ready')
    await click('Voice Activation')
    await until(()=>voice.snapshot.state==='armed','armed')
    assert.equal(await js(`document.querySelector('.wake-status').textContent`),'Listening for Hey Megan')
    await until(()=>chat.snapshot.answer.includes('friendly robot')&&!voice.snapshot.speechActive&&voice.snapshot.state==='armed','reply drained and safe rearm')
    assert.equal(chat.snapshot.user,'please tell me a short story about a friendly robot.')
    assert.ok(events.some(e=>e.type==='state'&&e.state==='capturing'))
    assert.ok(events.some(e=>e.type==='state'&&e.state==='verifying'))
    assert.ok(events.some(e=>e.type==='speech-ack'))
    assert.equal(events.filter(e=>e.type==='transcript').length,1)
    await click('Activation on')
    await until(()=>!voice.snapshot.activation&&voice.snapshot.state==='idle','off')
    await click('Voice Activation')
    await until(()=>voice.snapshot.state==='armed','re-enabled explicitly')
    await click('Mute')
    await until(()=>voice.snapshot.muted&&!voice.snapshot.activation,'mute disables activation')
    await click('Unmute')
    await until(()=>!voice.snapshot.muted,'unmuted')
    assert.equal(voice.snapshot.activation,false)
    console.log('UI PASS: explicit opt-in, armed/capture/verify, real transcript/mock reply, credited speech, auto-rearm, off/mute, unmute stays off.')
    console.log('STATES',events.filter(e=>e.type==='state').map(e=>e.state).join(' -> '))
    exit=0
  } catch(error) { console.error(error); }
  finally {
    voice?.stop()
    socket?.close()
    if(child){
      child.stdin.end()
      const code=await Promise.race([new Promise(r=>child.once('exit',r)),wait(10000).then(()=>{child.kill();return -1})])
      if(code!==0){console.error('fixture sidecar exit',code);exit=1}
      if(exit===0){assert.ok(sink?.played>0&&sink?.opens>=2&&!sink?.activation&&!sink?.mic);console.log('SILENT SINK',JSON.stringify(sink),'sidecar exit',code)}
    }
    socket?.close()
    win?.destroy()
    app.exit(exit)
  }
})
