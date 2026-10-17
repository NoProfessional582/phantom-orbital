import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, session, Tray } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dragPosition } from './window-position'
import { previewState } from './preview-state'
import { chatHit, validGeometry, type ChatHitGeometry } from './chat-hit'
import { ChatController } from './chat-controller'
import { HermesClient } from './hermes-client'
import { hermesSettings } from './hermes-settings'
import { OpenAiClient } from './openai-client'
import { loadConfig, personaMessage, personalityPrompt, type OrbConfig } from './orb-config'
import { SidecarClient } from './sidecar-client'
import { VoiceController } from './voice-controller'
import { trustedControl, canApproveHotkey } from './approval-controls'
import type { ChatSnapshot } from '../shared/chat'
import { validVoiceMode } from '../shared/voice'
import { ReminderInbox, type Reminder } from './reminders'
import { migrateLegacyData } from './legacy-data'
import { BackgroundWatch } from './background-tasks'
import { randomUUID } from 'node:crypto'

const WIDTH = 320, HEIGHT = 400
const gallery = process.argv.includes('--gallery')
const uiPreview = !app.isPackaged && process.env.ORB_UI_PREVIEW === '1'
const mock = !app.isPackaged && (process.argv.includes('--mock-hermes') || uiPreview)
let chat: ChatController
let config: OrbConfig | undefined
let configError = ''
let voice: VoiceController | undefined
let sidecar: SidecarClient | undefined
let approvalShortcut = false
let win: BrowserWindow | null = null
let tray: Tray | null = null
let locked = false, ignore = true, moving = false, holding = false
let chromeVisible = false, chromeHoverCandidate = false, lastCursor = { x: -1, y: -1 }
let hitGeometry: ChatHitGeometry | undefined
let pointerStart = { x: 0, y: 0 }, windowStart = { x: 0, y: 0 }
let reminders: Reminder[] = []
let reminderInbox: ReminderInbox | undefined
let background: BackgroundWatch | undefined
const hasOutput = (s: ChatSnapshot) => !!(s.user || s.answer || s.notice || s.approval || voice?.snapshot.notice || reminders.length)

if (uiPreview) app.setPath('userData', join(process.cwd(), '.cache/ui-preview-userdata'))
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { win?.show(); win?.focus() })
  app.whenReady().then(create)
  app.on('window-all-closed', () => { /* tray owns lifetime */ })
}

interface SavedPositions { lastDisplay?: string; [display: string]: { x: number, y: number } | string | undefined }
function positions(): SavedPositions {
  try { return JSON.parse(readFileSync(join(app.getPath('userData'), 'positions.json'), 'utf8')) }
  catch { return {} }
}
function safePosition() {
  const all = positions()
  const display = screen.getAllDisplays().find(d => String(d.id) === all.lastDisplay) ?? screen.getPrimaryDisplay()
  const saved = all[String(display.id)] as {x:number,y:number} | undefined
  const work = display.workArea
  const x = saved?.x ?? work.x + work.width - WIDTH - 24
  const y = saved?.y ?? work.y + work.height - HEIGHT - 24
  return { x: Math.max(work.x, Math.min(work.x + work.width - WIDTH, x)), y: Math.max(work.y, Math.min(work.y + work.height - HEIGHT, y)) }
}
function savePosition() {
  if (!win || gallery) return
  const display = screen.getDisplayMatching(win.getBounds())
  const values = positions(), [x, y] = win.getPosition()
  values[String(display.id)] = { x, y }
  values.lastDisplay = String(display.id)
  writeFileSync(join(app.getPath('userData'), 'positions.json'), JSON.stringify(values))
}
function icon() {
  const pixels = Buffer.alloc(16 * 16 * 4)
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const r = Math.hypot(x - 7.5, y - 7.5), i = (y * 16 + x) * 4
    pixels[i] = 63; pixels[i + 1] = 246; pixels[i + 2] = 234
    pixels[i + 3] = r < 6.7 ? Math.round(255 * (.25 + .75 * Math.exp(-r * r / 13))) : 0
  }
  return nativeImage.createFromBitmap(pixels, { width: 16, height: 16 })
}
function chatClient(config: OrbConfig): ConstructorParameters<typeof ChatController>[0] {
  const harness = config.harness
  if (harness.type === 'openai') {
    let key = ''
    if (harness.apiKeyEnv) key = process.env[harness.apiKeyEnv] ?? ''
    else if (harness.apiKeyFile) key = readFileSync(harness.apiKeyFile, 'utf8').trim()
    return new OpenAiClient(harness.endpoint, harness.model, key, harness.sendPersonality ? personalityPrompt(config) : '')
  }
  // Hermes owns the personality (its profile's SOUL.md); Orb only relays.
  const settings = hermesSettings(harness)
  return new HermesClient(settings.endpoint, settings.key, fetch, false)
}
function create() {
  if (!uiPreview) try { migrateLegacyData(app.getPath('appData'), app.getPath('userData')) } catch { /* best effort; enrollment can be redone */ }
  let client: ConstructorParameters<typeof ChatController>[0]
  try {
    config = loadConfig(app.getAppPath())
    client = mock ? new HermesClient('http://127.0.0.1:18642', 'orb-mock-only', fetch, true) : chatClient(config)
  } catch (error) {
    configError = error instanceof Error && error.message.startsWith('orb.config') ? error.message : 'AI backend credentials unavailable. Check orb.config.json.'
    client = mock ? new HermesClient('http://127.0.0.1:18642', 'orb-mock-only', fetch, true)
      : { async start() { throw new Error(configError) }, async *events() {}, async stop() {} }
  }
  chat = new ChatController(client, snapshot => {
    voice?.chatChanged(snapshot)
    publishChat(snapshot)
    if (snapshot.approval && !snapshot.approval.pending) { win?.show(); win?.focus() }
  })
  if (configError) chat.warn(configError)
  chat.onProgress = origin => voice?.progress(origin)
  chat.progressNotice = personaMessage(config, 'stillWorking')
  if (client instanceof HermesClient) {
    // Sub-agent results arrive later as a new Hermes turn; show them like a reminder.
    const hermes = client
    background = new BackgroundWatch(session => hermes.sessionMessages(session), text => notify({
      id: randomUUID(), title: personaMessage(config, 'backgroundDone'), message: text.trim().slice(0, 2000), url: ''
    }), () => chat.snapshot.busy)
    chat.onCompleted = ({ delegations }) => { if (hermes.lastSession) void background?.completed(hermes.lastSession, delegations) }
  }
  if (!gallery && !uiPreview) {
    voice = new VoiceController(chat, message => sidecar?.send(message), () => {
      if (!voice?.snapshot.enabled || voice.snapshot.muted || ['transcribing', 'speaking', 'error'].includes(voice.snapshot.state)) holding = false
      publishChat()
    })
    sidecar = new SidecarClient(join(app.getAppPath(), 'sidecar'), message => {
      if (message.type === 'approval-hotkey') {
        if (approvalShortcut && canApproveHotkey(chat.snapshot.approval, !!win?.isVisible(), !!win?.isFocused(), locked, message.id)) void chat.respondApproval({ id: chat.snapshot.approval!.id, choice: 'once' })
      } else voice?.receive(message)
    }, () => voice?.disconnected(), mock && process.argv.includes('--voice-smoke'),
    join(app.getPath('userData'), 'voice-profiles', 'registered.json'),
    config && { wakePhrase: config.persona.wakePhrase, voice: config.persona.voice, fillers: config.persona.fillers, progress: config.persona.progress, speakerFilter: config.speakerFilter })
  }
  const { x, y } = safePosition()
  win = new BrowserWindow({
    width: gallery ? 1320 : WIDTH, height: gallery ? 1100 : HEIGHT, x, y,
    frame: false, transparent: !gallery, backgroundColor: gallery ? '#061114' : '#00000000',
    resizable: gallery, alwaysOnTop: !gallery, skipTaskbar: !gallery, show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  if (!gallery) {
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setIgnoreMouseEvents(true, { forward: true })
    // Some Windows compositors do not forward mousemove to an ignored transparent
    // window. Poll the actual screen cursor as a fallback so a real hover can enter.
    const hover = setInterval(() => {
      if (!win || !win.isVisible() || moving || holding) return
      const [wx, wy] = win.getPosition()
      const point = screen.getCursorScreenPoint()
      const candidate = chatHit(point, {x:wx,y:wy}, chat.snapshot.inputOpen, hasOutput(chat.snapshot), true, hitGeometry)
      const moved = point.x !== lastCursor.x || point.y !== lastCursor.y
      if (candidate && ((!chromeHoverCandidate) || (!chromeVisible && moved))) { chromeVisible = true; win.webContents.send('orb:reveal') }
      chromeHoverCandidate = candidate
      lastCursor = point
      const hit = currentHit(wx, wy)
      if (hit === !ignore) return
      ignore = !hit
      win.setIgnoreMouseEvents(ignore, {forward: true})
    }, 40)
    win.on('closed', () => clearInterval(hover))
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win?.webContents.getURL()) event.preventDefault()
  })
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url
    const dev = process.env.ELECTRON_RENDERER_URL
    const allowed = url.startsWith('file:') || (dev && url.startsWith(dev + '/')) || url.startsWith('devtools:')
    callback({ cancel: !allowed })
  })
  const file = gallery ? 'gallery.html' : 'index.html'
  const state = !app.isPackaged && !gallery ? previewState(process.argv) : undefined
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${file}${state ? `?state=${state}` : ''}`)
  else win.loadFile(join(__dirname, `../renderer/${file}`), { query: state ? {state} : {} })
  win.once('ready-to-show', () => win?.show())
  win.webContents.on('did-finish-load', () => publishChat())
  win.on('focus', () => publishChat())
  win.on('blur', () => publishChat())
  win.on('moved', savePosition)
  win.on('show', () => { reminderInbox?.touch(); win?.webContents.send('orb:visible', !locked) })
  win.on('hide', () => { reminderInbox?.touch(); win?.webContents.send('orb:visible', false) })
  win.on('closed', () => { win = null; reminderInbox?.touch() })
  powerMonitor.on('lock-screen', () => { locked = true; reminderInbox?.touch(); voice?.mode(false); if (chat.snapshot.approval) void chat.stop(); win?.webContents.send('orb:visible', false) })
  powerMonitor.on('unlock-screen', () => { locked = false; reminderInbox?.touch(); win?.webContents.send('orb:visible', win?.isVisible() ?? false) })
  if (!gallery && !uiPreview) {
    tray = new Tray(icon())
    tray.setToolTip('Phantom Orbital Assistant')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show / hide orb', click: () => win?.isVisible() ? win.hide() : win?.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ]))
    tray.on('double-click', () => win?.isVisible() ? win.hide() : win?.show())
    // Hermes reminder scripts deliver here while Orb is visible, else they toast.
    reminderInbox = new ReminderInbox(join(app.getPath('userData'), 'reminders'), () => !!win?.isVisible() && !locked, notify)
    reminderInbox.start()
    const shortcut = globalShortcut.register('CommandOrControl+Shift+Space', toggleInput)
    if (!shortcut) {
      chat.warn('Ctrl+Shift+Space is unavailable globally (already reserved by another app/system). Click Text to chat.')
      win.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && !input.isAutoRepeat && input.control && input.shift && !input.alt && !input.meta && input.code === 'Space') {
          event.preventDefault(); toggleInput()
        }
      })
    }
    // Registration itself checks reservation without injecting the chord.
    // Reserve only; authenticated physical down/up edges prevent OS autorepeat
    // from approving a second card. A held chord across restart is not armed.
    approvalShortcut = globalShortcut.register('Control+Alt+Y', () => {})
    if (!approvalShortcut) chat.warn('Ctrl+Alt+Y is reserved by another app/system. Use the approval buttons.')
    const muteShortcut = globalShortcut.register('Control+Alt+M', () => { if (!locked) voice?.mute() })
    if (voice) { voice.snapshot.hotkeyAvailable = shortcut; voice.snapshot.muteShortcutAvailable = muteShortcut }
    if (!muteShortcut) chat.warn('Ctrl+Alt+M is unavailable globally. Use Off instead.')
    void sidecar?.start().then(() => {
      sidecar?.send({ type: 'hotkey', enabled: shortcut })
      publishChat()
    }).catch(() => voice?.disconnected())
  }
}

/** A reminder or background result: a card with a chime, shown even if the orb was hidden. */
function notify(reminder: Reminder) {
  reminders = [...reminders, reminder].slice(-5)
  if (win && !win.isVisible()) win.show()
  publishChat()
  win?.webContents.send('orb:reveal')
}

function publishChat(snapshot: ChatSnapshot = chat.snapshot) {
  if (!win || gallery) return
  const card = snapshot.approval
  sidecar?.send({ type: 'approval-hotkey', enabled: approvalShortcut, card: card && canApproveHotkey(card, win.isVisible(), win.isFocused(), locked, card.id) ? card.id : null })
  const notice = snapshot.notice || voice?.snapshot.notice || ''
  const expanded = snapshot.inputOpen || !!(snapshot.user || snapshot.answer || notice || snapshot.approval || reminders.length)
  const height = expanded ? 520 : HEIGHT
  if (win.getSize()[1] !== height) {
    win.setMinimumSize(WIDTH, HEIGHT)
    win.setMaximumSize(WIDTH, 520)
    win.setSize(WIDTH, height)
    const display = screen.getDisplayMatching(win.getBounds()), [x, y] = win.getPosition()
    win.setPosition(x, Math.max(display.workArea.y, Math.min(y, display.workArea.y + display.workArea.height - height)))
  }
  win.webContents.send('orb:chat', { ...snapshot, notice, reminders, assistant: { name: config?.persona.name ?? 'Megan', wakePhrase: config?.persona.wakePhrase ?? 'Hey Megan', user: config?.user.name ?? 'You' }, voice: voice?.snapshot, approvalShortcutAvailable: approvalShortcut && !!voice?.snapshot.ready, synthetic: mock, syntheticAudio: mock && process.argv.includes('--voice-smoke') })
}

function currentHit(x: number, y: number) {
  const s = chat.snapshot
  return chatHit(screen.getCursorScreenPoint(), { x, y }, s.inputOpen, hasOutput(s), chromeVisible, hitGeometry)
}
function toggleInput() {
  if (gallery || locked || !win) return
  chat.toggleInput()
  if (chat.snapshot.inputOpen) { win.show(); win.focus() }
}
app.on('will-quit', () => { globalShortcut.unregisterAll(); reminderInbox?.stop(); background?.stop() })
let quitting = false
app.on('before-quit', event => {
  if (!quitting && sidecar?.pid) {
    event.preventDefault()
    quitting = true
    void sidecar.close().finally(() => app.quit()).catch(() => {})
  }
})
// Only the trusted top-level renderer gets a narrow text/run bridge. No raw
// HTTP, credentials, endpoint settings or raw tool payloads cross IPC.
for (const channel of ['submit', 'text-activity', 'stop', 'toggle-input', 'dismiss', 'voice-mode', 'voice-activation', 'mute', 'ptt', 'voice-preview', 'enroll-voice', 'approval', 'new-conversation', 'recover', 'restart-voice', 'reminder-dismiss'] as const) {
  ipcMain.on(`orb:${channel}`, (event, ...args: unknown[]) => {
    if (gallery || !trustedControl(event, win?.webContents, locked)) return
    if (channel === 'reminder-dismiss' && args.length === 1 && typeof args[0] === 'string') { reminders = reminders.filter(r => r.id !== args[0]); publishChat(); return }
    if (channel === 'approval' && args.length === 1) { void chat.respondApproval(args[0]); return }
    if (channel === 'voice-mode' && args.length === 1 && validVoiceMode(args[0])) { voice?.setMode(args[0]); return }
    if (channel === 'text-activity' && args.length === 1 && typeof args[0] === 'boolean') { holding = false; voice?.textActivity(args[0]); return }
    if (channel === 'submit' && args.length === 1) { holding = false; voice?.textActivity(false); void chat.submit(args[0]) }
    else if (channel === 'ptt' && args.length === 1 && typeof args[0] === 'boolean') {
      voice?.hold(args[0])
      holding = args[0] && !!voice?.snapshot.enabled && !voice.snapshot.muted && !chat.snapshot.busy
      if (holding) { ignore = false; win?.setIgnoreMouseEvents(false) }
    }
    else if (args.length === 0) {
      if (channel === 'stop') { holding = false; voice?.stop(); void chat.stop() }
      if (channel === 'new-conversation') { holding = false; voice?.stop(); void chat.newConversation() }
      if (channel === 'recover') { holding = false; voice?.mode(false); void chat.recover() }
      if (channel === 'restart-voice' && voice && !voice.snapshot.ready) {
        voice.disconnected()
        void sidecar?.restart().then(() => {
          sidecar?.send({ type: 'hotkey', enabled: voice?.snapshot.hotkeyAvailable === true })
          publishChat()
        }).catch(() => chat.warn('Local voice restart failed or two-attempt limit reached. Check local setup; no cloud fallback.'))
      }
      if (channel === 'toggle-input') toggleInput()
      if (channel === 'dismiss') chat.dismiss()
      if (channel === 'voice-mode') voice?.cycleMode()
      if (channel === 'mute') voice?.mute()
      if (channel === 'enroll-voice') voice?.enroll()
      if (channel === 'voice-activation') voice?.setMode('active')
      if (channel === 'voice-preview' && voice?.snapshot.ready && !chat.snapshot.busy) {
        voice.mode(true)
        sidecar?.send({ type: 'speak', chunks: [personaMessage(config, 'voicePreview')] })
      }
    }
  })
}

ipcMain.on('orb:hit', (event, hit: unknown) => {
  if (event.sender !== win?.webContents || gallery || typeof hit !== 'boolean' || moving || holding) return
  // Forwarded renderer events are asynchronous hints, not cursor authority.
  // A queued inside hint after the cursor exits must never re-enable capture.
  const [wx, wy] = win.getPosition()
  const actualHit = currentHit(wx, wy)
  if (actualHit === !ignore) return
  ignore = !actualHit
  win.setIgnoreMouseEvents(ignore, { forward: true })
})
ipcMain.on('orb:chrome', (event, visible: unknown) => {
  if (event.sender !== win?.webContents || gallery || typeof visible !== 'boolean') return
  chromeVisible = visible
  const [wx, wy] = win.getPosition(), actualHit = currentHit(wx, wy)
  if (actualHit === !ignore) return
  ignore = !actualHit
  win.setIgnoreMouseEvents(ignore, { forward: true })
})
ipcMain.on('orb:geometry', (event, value: unknown) => {
  const current = win
  if (!trustedControl(event, current?.webContents, locked) || gallery || !validGeometry(value) || !current) return
  hitGeometry = value
  const [wx, wy] = current.getPosition(), actualHit = currentHit(wx, wy)
  if (actualHit === !ignore) return
  ignore = !actualHit
  current.setIgnoreMouseEvents(ignore, { forward: true })
})
ipcMain.on('orb:drag', (event, action: unknown, x: unknown, y: unknown) => {
  if (gallery || !win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return
  // Ending a drag is always allowed so a lock mid-drag can't leave it stuck.
  if (action === 'end') { if (moving) { moving = false; savePosition() } return }
  if (!trustedControl(event, win.webContents, locked) || !Number.isFinite(x) || !Number.isFinite(y)) return
  if (action === 'start' && typeof x === 'number' && typeof y === 'number') {
    moving = true; pointerStart = { x, y }
    const [wx, wy] = win!.getPosition(); windowStart = { x: wx, y: wy }
    win!.setIgnoreMouseEvents(false)
  }
  else if (action === 'move' && moving && typeof x === 'number' && typeof y === 'number') {
    const { x: wx, y: wy } = dragPosition(windowStart, pointerStart, { x, y })
    win!.setPosition(wx, wy)
  }
})
ipcMain.on('orb:hide', event => { if (event.sender === win?.webContents) win.hide() })