import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('orb', {
  hit: (inside: boolean) => ipcRenderer.send('orb:hit', inside),
  chrome: (visible: boolean) => ipcRenderer.send('orb:chrome', visible),
  geometry: (value: unknown) => ipcRenderer.send('orb:geometry', value),
  onReveal: (callback: () => void) => ipcRenderer.on('orb:reveal', callback),
  drag: (action: 'start' | 'move' | 'end', x = 0, y = 0) => ipcRenderer.send('orb:drag', action, x, y),
  hide: () => ipcRenderer.send('orb:hide'),
  submit: (text: string) => ipcRenderer.send('orb:submit', text),
  textActivity: (hasDraft: boolean) => ipcRenderer.send('orb:text-activity', hasDraft),
  stop: () => ipcRenderer.send('orb:stop'),
  approval: (id: string, choice: 'once' | 'deny') => ipcRenderer.send('orb:approval', { id, choice }),
  newConversation: () => ipcRenderer.send('orb:new-conversation'),
  recover: () => ipcRenderer.send('orb:recover'),
  restartVoice: () => ipcRenderer.send('orb:restart-voice'),
  toggleInput: () => ipcRenderer.send('orb:toggle-input'),
  dismiss: () => ipcRenderer.send('orb:dismiss'),
  voiceMode: () => ipcRenderer.send('orb:voice-mode'),
  enrollVoice: () => ipcRenderer.send('orb:enroll-voice'),
  voiceActivation: () => ipcRenderer.send('orb:voice-activation'),
  mute: () => ipcRenderer.send('orb:mute'),
  ptt: (down: boolean) => ipcRenderer.send('orb:ptt', down),
  voicePreview: () => ipcRenderer.send('orb:voice-preview'),
  dismissReminder: (id: string) => ipcRenderer.send('orb:reminder-dismiss', id),
  onChat: (callback: (snapshot: import('../shared/chat').ChatSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: import('../shared/chat').ChatSnapshot) => callback(snapshot)
    ipcRenderer.on('orb:chat', listener)
    return () => ipcRenderer.removeListener('orb:chat', listener)
  },
  onVisible: (callback: (visible: boolean) => void) => ipcRenderer.on('orb:visible', (_event, visible: boolean) => callback(visible))
})
