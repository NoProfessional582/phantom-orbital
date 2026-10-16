import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { SPEECH_FRAME_BYTES } from './speech-text'

// Credentials stay in main. Fresh launch token is sent in an auth frame, never a URL.
export class SidecarClient {
  private child?: ChildProcessWithoutNullStreams
  private socket?: WebSocket
  private closing = false
  private transportFailed = false
  private restarts = 0
  private restarting?: Promise<void>
  get pid() { return this.child?.pid }
  constructor(private root: string, private receive: (message: Record<string, unknown>) => void, private disconnected: () => void, private synthetic = false, private profilePath?: string, private persona?: { wakePhrase: string; voice: object; fillers: string[] }) {}
  start(): Promise<void> {
    if (this.child) return Promise.reject(new Error('Local sidecar already started'))
    this.closing = false
    this.transportFailed = false
    const token = randomBytes(32).toString('hex')
    const env: NodeJS.ProcessEnv = {}
    // Do not pass gateway keys, cloud credentials or Hermes configuration to Python.
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PATH']) {
      if (process.env[name]) env[name] = process.env[name]
    }
    Object.assign(env, { ORB_VOICE_TOKEN: token, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' })
    // Persona voice settings only (wake phrase, Piper voice, filler lines); no credentials.
    if (this.persona) env.ORB_PERSONA = JSON.stringify(this.persona)
    if (this.profilePath) env.ORB_VOICE_PROFILE = this.synthetic ? join(this.root, '..', '.cache', 'synthetic-voice', 'voice-profile.json') : this.profilePath
    const child = this.child = spawn(join(this.root, '.venv', 'Scripts', 'python.exe'), ['-E', '-s', join(this.root, 'server.py'), ...(this.synthetic ? ['--synthetic-smoke'] : [])], { cwd: this.root, env, windowsHide: true, stdio: 'pipe' })
    // stderr can contain native diagnostics, never relay it into captions/logs.
    child.stderr.resume()
    return new Promise((resolve, reject) => {
      let settled = false, failed = false, buffer = '', connected = false
      const fail = () => {
        if (failed) return
        failed = true
        this.socket?.close()
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Local voice sidecar unavailable; run local setup.')) }
        if (!this.closing && !this.transportFailed) { this.transportFailed = true; this.disconnected() }
      }
      const timer = setTimeout(() => { fail(); void this.close().catch(() => {}) }, 10_000)
      child.on('error', () => { if (this.child === child) { this.child = undefined; fail() } })
      child.on('exit', () => { if (this.child === child) { this.child = undefined; fail() } })
      child.stdout.on('data', (chunk: Buffer) => {
        if (connected) return
        buffer += chunk.toString('utf8')
        if (buffer.length > 4096) { fail(); void this.close().catch(() => {}); return }
        if (!buffer.includes('\n')) return
        try {
          const info = JSON.parse(buffer.split('\n')[0]) as { port?: number }
          if (!Number.isInteger(info.port) || info.port! < 1 || info.port! > 65535) { fail(); void this.close().catch(() => {}); return }
          connected = true
          const socket = this.socket = new WebSocket(`ws://127.0.0.1:${info.port}`)
          socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', token })))
          socket.addEventListener('message', event => {
            if (failed || this.transportFailed || this.child !== child || this.closing) return
            if (typeof event.data !== 'string' || event.data.length > 16384) { socket.close(); return }
            try {
              const data: unknown = JSON.parse(event.data)
              if (!data || typeof data !== 'object' || Array.isArray(data)) { socket.close(); return }
              const message = data as Record<string, unknown>
              if (!settled) {
                if (message.type !== 'ready') { fail(); socket.close(); return }
                settled = true; clearTimeout(timer); resolve()
              }
              this.receive(message)
            } catch { socket.close() }
          })
          socket.addEventListener('error', fail)
          socket.addEventListener('close', fail)
        } catch { fail(); void this.close().catch(() => {}) }
      })
    })
  }
  send(message: object) {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN || this.transportFailed) return
    const body = JSON.stringify(message), bytes = Buffer.byteLength(body, 'utf8')
    if (bytes > SPEECH_FRAME_BYTES || socket.bufferedAmount + bytes > SPEECH_FRAME_BYTES) {
      this.transportFailed = true
      socket.close()
      this.disconnected()
      return
    }
    socket.send(body)
  }
  restart(): Promise<void> {
    if (this.restarting) return this.restarting
    if (this.restarts >= 2) return Promise.reject(new Error('Local voice restart limit reached; restart Orb after checking models.'))
    this.restarts++
    const restarting = this.restarting = this.close().then(() => this.start())
    void restarting.finally(() => { this.restarting = undefined }).catch(() => {})
    return restarting
  }
  async close() {
    this.closing = true
    this.socket?.close()
    const child = this.child
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) { this.child = undefined; return }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); }, 1500)
      const deadline = setTimeout(() => { clearTimeout(timer); reject(new Error('Local sidecar shutdown unconfirmed; no replacement started.')) }, 3000)
      child.once('exit', () => { clearTimeout(timer); clearTimeout(deadline); resolve() })
      child.stdin.end()
    })
    this.child = undefined
  }
}
