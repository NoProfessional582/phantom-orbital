// Separate Electron process/userData. No ordinary app restart or shortcuts.
// Reuses production controllers, preload, renderer, VoiceServer and native models.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import ts from 'typescript'
import { startMock } from './mock-hermes.mjs'
const root = resolve('.'), cache = join(root, '.cache/m6-ui')
mkdirSync(cache, { recursive: true })
writeFileSync(join(cache, 'package.json'), '{"type":"commonjs"}')
for (const name of readdirSync(join(root,'src/main')).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
  writeFileSync(join(cache, name.replace(/\.ts$/, '.js')), ts.transpileModule(readFileSync(join(root,'src/main',name),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)
}
const mock = await startMock({ delay: 100 })
const child = spawn(join(root,'node_modules/electron/dist/electron.exe'), [join(root,'scripts/wake-ui.cjs'), root, mock.endpoint], {cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true})
let output=''
child.stdout.on('data', d => { output+=d; process.stdout.write(d) })
child.stderr.on('data', d => process.stderr.write(d))
const timeout=setTimeout(()=>child.kill(),120000)
try {
  const code=await new Promise((r,j)=>{child.on('error',j);child.on('exit',r)})
  if(code!==0) throw new Error(`Wake UI smoke exited ${code}`)
  const requests=mock.requests.filter(r=>r.method==='POST'&&r.path==='/v1/runs')
  if(requests.length!==1||!/friendly robot/i.test(requests[0].body.input)||/^hey megan/i.test(requests[0].body.input)) throw new Error('Expected exactly one clean command through HTTP mock')
  console.log('PASS authenticated UI -> real KWS/VAD/speaker/Whisper -> mock HTTP/SSE -> local Piper silent sink; exactly one command:', requests[0].body.input)
} finally { clearTimeout(timeout); await mock.close() }
