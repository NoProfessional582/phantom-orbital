// Capture frames of each orb state from an isolated preview window over CDP.
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const out = process.argv[2], seconds = Number(process.argv[3] || 3)
const states = ['idle', 'listening', 'thinking', 'speaking']
const pages = await (await fetch('http://127.0.0.1:9335/json')).json()
const page = pages.find(p => p.type === 'page' && p.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let id = 0; const pending = new Map()
ws.onmessage = e => { const v = JSON.parse(e.data); const p = pending.get(v.id); if (p) { pending.delete(v.id); v.error ? p.reject(new Error(JSON.stringify(v.error))) : p.resolve(v.result) } }
const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })) })
await call('Page.enable')
await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
await call('Emulation.setDefaultBackgroundColorOverride', { color: { r: 13, g: 17, b: 23, a: 1 } })
const base = page.url.split('?')[0]
for (const state of states) {
  const dir = join(out, state); mkdirSync(dir, { recursive: true })
  await call('Page.navigate', { url: `${base}?state=${state}` })
  await new Promise(r => setTimeout(r, 2500))
  const start = Date.now(); let n = 0; const times = []
  while (Date.now() - start < seconds * 1000) {
    const t = Date.now() - start
    const shot = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 320, height: 320, scale: 1 } })
    writeFileSync(join(dir, `${String(n++).padStart(4, '0')}.png`), Buffer.from(shot.data, 'base64')); times.push(t)
  }
  writeFileSync(join(dir, 'times.json'), JSON.stringify(times))
  console.log(state, n, 'frames')
}
ws.close()
