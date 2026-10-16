import type { ChatSnapshot } from '../shared/chat'
import { nextVoiceMode, validVoiceMode, type VoiceMode, type VoiceSnapshot } from '../shared/voice'
import type { ChatController } from './chat-controller'
import { SentenceBuffer, SPEECH_FRAME_BYTES } from './speech-text'

export class VoiceController {
  snapshot: VoiceSnapshot = { mode: 'off', nextMode: 'voice', activation: false, enabled: false, ready: false, muted: false, state: 'idle', level: 0, notice: '', device: 'unloaded', hotkeyAvailable: false, muteShortcutAvailable: false }
  private desiredMode: VoiceMode = 'off'
  private modeRevision = 0
  cycleMode() { this.setMode(nextVoiceMode(this.desiredMode)) }
  setMode(value: unknown) {
    if (!validVoiceMode(value)) return
    if (value === 'active' && this.desiredMode === value && this.snapshot.mode === value) return
    if (value !== 'off' && !this.snapshot.ready) { this.snapshot.notice = 'Local voice unavailable. Voice remains off.'; this.changed(); return }
    this.speechNotice = ''
    if (value !== 'active') this.stop(false)
    this.desiredMode = value
    this.snapshot.nextMode = nextVoiceMode(value)
    this.snapshot.enabled = value !== 'off'
    this.snapshot.muted = false
    this.snapshot.mode = value === 'off' ? 'off' : 'voice'
    this.snapshot.pendingMode = undefined
    this.snapshot.notice = value !== 'off' && !this.snapshot.registered ? 'Not enrolled. Choose Enroll voice; typed text still works.' : ''
    const target = value === 'active' && !this.snapshot.registered ? 'voice' : value
    if (target === 'active') this.snapshot.pendingMode = 'active'
    this.send({ type: 'voice-mode', mode: target, revision: ++this.modeRevision })
    this.pause(this.chat.snapshot.busy || !!this.stream)
    this.pendingCancel = false
    this.changed()
  }
  private voiceRun = false
  private wasBusy = false
  private expectingTranscript = false
  private pendingCancel = false
  private stream?: { id: string; buffer: SentenceBuffer; queue: string[]; bytes: number; seq: number; waiting: boolean; final: boolean; finished: boolean; sent: boolean }
  private runId?: string
  private paused?: boolean
  private speechNotice = ''
  private followupId?: string
  private get followup() { return this.followupId }
  private set followup(id: string | undefined) { this.followupId = id; this.snapshot.followupActive = !!id }
  private origin?: 'voice' | 'text'
  private draft = false
  private expiry?: ReturnType<typeof setTimeout>
  private expiryGeneration = 0
  constructor(private chat: ChatController, private send: (message: object) => void, private changed: () => void) {}
  textActivity(hasDraft: boolean) {
    // Last deliberate input owns the lifecycle. Never erase a renderer draft.
    if (this.stream || this.followup || this.snapshot.enrolling || ['listening', 'capturing', 'verifying', 'transcribing'].includes(this.snapshot.state)) this.stop(true, true)
    this.draft = hasDraft
    if (hasDraft) this.chat.prepare()
    this.origin = 'text'
    this.scheduleExpiry()
  }
  private clearExpiry() {
    clearTimeout(this.expiry)
    this.expiry = undefined
    this.expiryGeneration++
  }
  private idleForExpiry() {
    return !this.chat.snapshot.busy && !this.chat.snapshot.approval && !this.stream && !this.followup && !this.draft && !this.snapshot.enrolling && !['listening', 'followup', 'capturing', 'verifying', 'transcribing'].includes(this.snapshot.state)
  }
  private scheduleExpiry() {
    this.clearExpiry()
    const speech = this.chat.snapshot.speech
    if (!this.origin || speech?.phase !== 'complete' || !this.idleForExpiry()) return
    const generation = this.expiryGeneration, id = speech.id
    this.expiry = setTimeout(() => {
      if (generation !== this.expiryGeneration || id !== this.chat.snapshot.speech?.id || !this.idleForExpiry()) return
      this.clearExpiry()
      this.origin = undefined
      this.snapshot.notice = ''
      this.speechNotice = ''
      void this.chat.newConversation(true)
    }, this.origin === 'voice' ? 5000 : 60000)
    this.expiry.unref?.()
  }
  activation(enabled: boolean) {
    this.setMode(enabled ? 'active' : 'voice')
  }
  enroll() {
    if (!this.snapshot.enabled || !this.snapshot.ready || this.snapshot.muted || this.chat.snapshot.busy || this.snapshot.state !== 'idle') return
    this.speechNotice = ''
    this.stop()
    this.snapshot.enrolling = true
    this.snapshot.enrollmentCount = 0
    this.send({ type: 'enroll' })
    this.changed()
  }
  mode(enabled: boolean) {
    this.setMode(enabled ? 'voice' : 'off')
  }
  mute() {
    this.setMode('off')
  }
  hold(down: boolean) {
    if (!down) this.send({ type: 'release' })
    else if (this.snapshot.enabled && this.snapshot.ready && !this.snapshot.muted && !this.stream && !this.chat.snapshot.busy && (this.followup || ['idle', 'armed'].includes(this.snapshot.state))) {
      this.clearExpiry()
      this.origin = 'voice'
      this.followup = undefined
      this.send({ type: 'start' })
    }
  }
  stop(synchronize = true, preserveMode = false) {
    if (!preserveMode) this.desiredMode = this.snapshot.enabled ? 'voice' : 'off'
    this.snapshot.nextMode = nextVoiceMode(this.desiredMode)
    if (!preserveMode) {
      this.snapshot.mode = this.desiredMode
      this.snapshot.pendingMode = undefined
    }
    this.clearExpiry()
    this.followup = undefined
    if (!preserveMode) this.snapshot.activation = false
    this.stream = undefined
    this.snapshot.speechActive = false
    this.snapshot.enrolling = false
    this.voiceRun = false
    this.expectingTranscript = false
    this.pendingCancel = true
    this.snapshot.level = 0
    this.snapshot.state = this.snapshot.muted ? 'muted' : 'idle'
    if (synchronize) {
      this.send({ type: 'cancel' })
      this.send({ type: 'voice-mode', mode: this.desiredMode, revision: ++this.modeRevision })
      this.pause(this.chat.snapshot.busy)
    }
    this.scheduleExpiry()
    if (synchronize) this.changed()
  }
  disconnected() {
    this.desiredMode = 'off'
    this.snapshot.nextMode = 'voice'
    this.modeRevision++
    this.snapshot.mode = 'off'
    this.snapshot.pendingMode = undefined
    this.snapshot.muted = false
    this.clearExpiry()
    this.followup = undefined
    this.snapshot.activation = false
    this.stream = undefined
    this.snapshot.speechActive = false
    this.paused = undefined
    this.snapshot.enrolling = false
    this.snapshot.registered = false
    this.snapshot.enabled = false
    this.expectingTranscript = false
    this.pendingCancel = true
    this.snapshot.ready = false
    this.snapshot.level = 0
    this.snapshot.state = 'error'
    this.snapshot.notice = 'Local sidecar stopped. Text still works. Restart local voice (two attempts maximum); no cloud fallback.'
    this.voiceRun = false
    this.scheduleExpiry()
    this.changed()
  }
  chatChanged(snapshot: ChatSnapshot) {
    const speech = snapshot.speech
    const settled = this.wasBusy && !snapshot.busy
    if (!speech) {
      this.clearExpiry()
      this.followup = undefined
      this.origin = undefined
    }
    if (snapshot.busy && !this.wasBusy) {
      this.clearExpiry()
      this.followup = undefined
      if (this.stream) { this.send({ type: 'cancel' }); this.stream = undefined }
      this.voiceRun = snapshot.inputOrigin === 'voice'
      this.origin = this.voiceRun ? 'voice' : 'text'
      this.runId = this.voiceRun ? speech?.id : undefined
    }
    this.wasBusy = snapshot.busy
    if (snapshot.stopping || snapshot.state === 'offline' || speech?.phase === 'failed' || this.stream && speech?.id !== this.stream.id) {
      this.stop()
    } else if (this.voiceRun && this.runId === speech?.id && this.snapshot.enabled && !this.snapshot.muted && speech) {
      if (speech.phase === 'interim') {
        if (this.stream?.sent) this.refuse('Hermes identified streamed text as interim/tool progress. Earlier speech may have played; remaining speech stopped. Read the final captions.')
      } else {
        if (!this.stream) {
          this.stream = { id: speech.id, buffer: new SentenceBuffer(), queue: [], bytes: 0, seq: 0, waiting: false, final: false, finished: false, sent: false }
          this.send({ type: 'speech-begin', stream: speech.id })
        }
        const stream = this.stream
        try {
          if (speech.text.length > 100_000) throw new Error('Speech source exceeds the 100,000-character limit')
          const chunks = stream.buffer.update(speech.text, speech.phase === 'complete')
          const bytes = chunks.reduce((n, text) => n + Buffer.byteLength(text, 'utf8'), 0)
          if (stream.bytes + bytes > SPEECH_FRAME_BYTES) throw new Error('Local speech backlog exceeds the 16 KiB limit')
          stream.queue.push(...chunks); stream.bytes += bytes
          stream.final ||= speech.phase === 'complete'
          this.pump()
        } catch (error) { this.refuse(`${(error as Error).message}. Earlier speech may have played; remaining speech stopped. Read the complete captions.`) }
      }
    }
    this.snapshot.speechActive = !!this.stream
    this.pause(snapshot.busy || !!this.stream)
    if (settled && !this.stream) this.scheduleExpiry()
  }
  private pause(paused: boolean) {
    if (this.paused === paused) return
    this.paused = paused
    this.send({ type: 'pause', paused })
  }
  private refuse(notice: string) {
    this.stop()
    this.speechNotice = notice
    this.snapshot.notice = notice
    this.changed()
  }
  private pump() {
    const stream = this.stream
    if (!stream || stream.waiting || stream.finished) return
    if (stream.queue.length) {
      stream.waiting = true; stream.sent = true
      this.send({ type: 'speech-append', stream: stream.id, seq: stream.seq, text: stream.queue[0] })
    } else if (stream.final) {
      stream.finished = true
      this.send({ type: 'speech-finish', stream: stream.id })
    }
  }
  receive(message: unknown) {
    if (!message || typeof message !== 'object') return
    const data = message as Record<string, unknown>
    if (typeof data.revision === 'number' && data.revision !== this.modeRevision) return
    if (data.type === 'mode-ready') {
      if (data.revision !== this.modeRevision || !validVoiceMode(data.mode)) return
      if (data.mode === 'active' && this.desiredMode !== 'active') return
      this.snapshot.mode = data.mode
      this.snapshot.activation = data.mode === 'active'
      this.snapshot.pendingMode = undefined
      this.pendingCancel = false
      this.changed(); return
    }
    if (typeof data.followup === 'string' && data.followup !== this.followup) return
    if (data.type === 'followup-ended') {
      if (data.id !== this.followup || !this.followup || this.chat.snapshot.busy) return
      const id = this.followup
      this.followup = undefined
      this.expectingTranscript = false
      this.clearExpiry()
      this.origin = undefined
      this.snapshot.notice = ''
      this.speechNotice = ''
      void this.chat.newConversation(true)
      this.send({ type: 'followup-reset', id })
      this.changed(); return
    }
    if (typeof data.stream === 'string' && data.stream !== this.stream?.id) return
    if (data.type === 'speech-ack') {
      const stream = this.stream
      if (stream && stream.waiting && data.seq === stream.seq) {
        stream.bytes -= Buffer.byteLength(stream.queue.shift()!, 'utf8')
        stream.waiting = false; stream.seq++
        this.pump()
      }
      return
    }
    if (data.type === 'speech-done') {
      if (!this.stream?.finished) return
      const id = this.stream.id
      const played = this.stream.sent && this.stream.seq > 0 && data.played === true
      this.stream = undefined; this.voiceRun = false
      this.snapshot.speechActive = false
      this.snapshot.state = this.snapshot.muted ? 'muted' : 'idle'
      if (!played) { this.stop(); return }
      if (played && !this.chat.snapshot.busy && this.snapshot.enabled && !this.snapshot.muted && this.snapshot.ready && !this.draft) {
        this.followup = id
        this.send({ type: 'followup', id })
      }
      this.pause(this.chat.snapshot.busy)
      if (!this.followup) this.scheduleExpiry()
      this.changed(); return
    }
    if (data.type === 'ready') {
      this.desiredMode = 'off'
      this.snapshot.nextMode = 'voice'
      this.snapshot.mode = 'off'
      this.snapshot.pendingMode = undefined
      this.snapshot.muted = false
      this.clearExpiry()
      this.followup = undefined
      this.stream = undefined
      this.voiceRun = false
      this.snapshot.speechActive = false
      this.snapshot.enabled = false
      this.snapshot.activation = false
      this.send({ type: 'activation', enabled: false })
      this.snapshot.ready = true
      this.snapshot.state = this.snapshot.muted ? 'muted' : 'idle'
      this.snapshot.notice = ''
      this.speechNotice = ''
      this.expectingTranscript = false
      this.pendingCancel = false
      this.send({ type: 'mute', muted: this.snapshot.muted })
      this.paused = undefined
      this.pause(this.chat.snapshot.busy)
      this.send({ type: 'mode', enabled: this.snapshot.enabled })
      this.send({ type: 'voice-mode', mode: 'off', revision: ++this.modeRevision })
      this.scheduleExpiry()
    } else if (data.type === 'activation' && typeof data.enabled === 'boolean') {
      if (!data.enabled) this.snapshot.activation = false
    } else if (data.type === 'wake-error' && typeof data.message === 'string') {
      this.stop()
      this.desiredMode = 'active' // the next primary click must always offer Off after failure
      this.snapshot.nextMode = 'off'
      this.speechNotice = data.message.slice(0, 600)
      this.snapshot.notice = this.speechNotice
    } else if (data.type === 'cancelled') {
      this.pendingCancel = false
    } else if (data.type === 'speaker' && typeof data.registered === 'boolean' && typeof data.enrolling === 'boolean' && Number.isInteger(data.count) && Number(data.count) >= 0 && Number(data.count) <= 6 && typeof data.message === 'string' && data.message.length <= 600) {
      this.expectingTranscript = false
      this.snapshot.registered = data.registered
      this.snapshot.enrolling = data.enrolling && this.snapshot.enabled && !this.snapshot.muted && !this.pendingCancel
      this.snapshot.enrollmentCount = Number(data.count)
      this.snapshot.notice = this.speechNotice || (this.snapshot.enabled ? data.message : '')
    } else if (data.type === 'transcript' && !this.snapshot.enrolling && this.snapshot.ready && this.expectingTranscript && !this.pendingCancel && this.snapshot.enabled && !this.snapshot.muted && !this.chat.snapshot.busy && typeof data.text === 'string' && data.text.trim() && data.text.length <= 8000) {
      this.expectingTranscript = false
      this.snapshot.device = data.device === 'cuda' ? 'cuda' : 'cpu'
      this.voiceRun = true
      this.speechNotice = ''
      this.snapshot.notice = ''
      void this.chat.submit(data.text, 'voice')
    } else if (data.type === 'state' && ['idle', 'listening', 'followup', 'transcribing', 'speaking', 'muted', 'error', 'arming', 'armed', 'capturing', 'verifying'].includes(String(data.state))) {
      if (!this.pendingCancel && (!this.stream || data.stream === this.stream.id)) {
        if (data.state === 'followup' && !this.followup) return
        if (['arming', 'armed', 'capturing', 'verifying'].includes(String(data.state)) && !this.snapshot.activation && !this.followup) return
        if (data.state === 'listening' && !data.followup) {
          this.followup = undefined
          this.origin = 'voice'
        }
        this.snapshot.state = data.state as VoiceSnapshot['state']
        if (['listening', 'followup', 'capturing', 'verifying', 'transcribing'].includes(String(data.state))) this.clearExpiry()
        else if (data.state === 'idle' && !this.chat.snapshot.busy && !this.stream && !this.followup) this.scheduleExpiry()
        if ((data.state === 'listening' || data.state === 'capturing' || data.state === 'followup') && this.snapshot.enabled && !this.snapshot.muted) this.expectingTranscript = true
        if (data.state === 'listening' || data.state === 'capturing') this.chat.prepare() // hide session setup behind speech
      }
    } else if (data.type === 'level' && typeof data.value === 'number' && Number.isFinite(data.value)) {
      this.snapshot.level = Math.max(0, Math.min(1, data.value))
    } else if (data.type === 'speech-rejected') {
      this.refuse('Local speech exceeds supported limits or is invalid. Earlier speech may have played; remaining speech stopped. Read the complete captions.')
    } else if (data.type === 'error') {
      this.stop()
      this.snapshot.state = 'error'
      this.snapshot.notice = 'Local voice unavailable. Check models/audio device; no cloud fallback.'
      this.speechNotice = this.snapshot.notice
    }
    this.changed()
  }
}
