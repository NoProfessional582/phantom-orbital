import { afterAll, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => void>()
  const sent: Record<string, unknown>[] = [], published: any[] = []
  const webContents = { mainFrame: {}, send: (_channel: string, value: unknown) => published.push(value), setWindowOpenHandler() {}, on() {}, getURL: () => 'file:///orb/index.html' }
  const win = { webContents, on() {}, once() {}, setAlwaysOnTop() {}, setIgnoreMouseEvents() {}, loadFile() {}, isVisible: () => true, isFocused: () => true, getSize: () => [320, 400], getPosition: () => [0, 0], getBounds: () => ({ x: 0, y: 0, width: 320, height: 400 }), setMinimumSize() {}, setMaximumSize() {}, setSize() {}, setPosition() {}, show() {}, focus() {} }
  let receive: (message: unknown) => void
  return { handlers, sent, published, win, webContents,
    setReceive: (callback: typeof receive) => { receive = callback },
    receive: (message: unknown) => receive(message) }
})
vi.mock('electron', () => ({
  app: { isPackaged: false, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), on() {}, getPath: () => process.cwd() + '/.cache/independent-text', getAppPath: () => process.cwd() },
  BrowserWindow: class { constructor() { return fixture.win } },
  ipcMain: { on: (channel: string, handler: (...args: any[]) => void) => fixture.handlers.set(channel, handler) },
  globalShortcut: { register: () => true, unregisterAll() {} },
  Menu: { buildFromTemplate: () => [] }, nativeImage: { createFromBitmap() {} }, powerMonitor: { on() {} },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1200, height: 900 } }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }) },
  session: { defaultSession: { webRequest: { onBeforeRequest() {} } } },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} }
}))
vi.mock('./hermes-settings', () => ({ hermesSettings: () => ({ endpoint: 'http://127.0.0.1:18642', key: 'orb-mock-only' }) }))
vi.mock('./sidecar-client', () => ({ SidecarClient: class {
  constructor(_root: string, receive: (message: unknown) => void) { fixture.setReceive(receive) }
  send(message: Record<string, unknown>) { fixture.sent.push(message) }
  async start() { fixture.receive({ type: 'ready' }); fixture.receive({ type: 'speaker', registered: true, enrolling: false, count: 0, message: '' }) }
} }))
vi.useFakeTimers()
vi.stubEnv('ORB_UI_PREVIEW', '')
await import('./index')
await Promise.resolve()
afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })

test.each(['off', 'voice', 'active'] as const)('real Text/Escape IPC opens and closes composer in %s without changing VoiceController status', mode => {
  const event = { sender: fixture.webContents, senderFrame: fixture.webContents.mainFrame }
  fixture.handlers.get('orb:voice-mode')!(event, mode)
  const command = [...fixture.sent].reverse().find(m => m.type === 'voice-mode')!
  fixture.receive({ type: 'mode-ready', mode, revision: command.revision })
  fixture.receive({ type: 'state', state: mode === 'active' ? 'armed' : 'idle', revision: command.revision })
  const before = { ...fixture.published.at(-1).voice }, count = fixture.sent.length
  fixture.handlers.get('orb:toggle-input')!(event)
  expect(fixture.published.at(-1).inputOpen).toBe(true)
  expect(fixture.published.at(-1).voice).toEqual(before)
  fixture.handlers.get('orb:toggle-input')!(event) // Escape uses this same IPC
  expect(fixture.published.at(-1).inputOpen).toBe(false)
  expect(fixture.published.at(-1).voice).toEqual(before)
  expect(fixture.sent.slice(count).some(m => m.type === 'voice-mode' || m.type === 'cancel')).toBe(false)
})
