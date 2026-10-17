import { createOrb } from './orb'
import { STATES, snapshotVisual, type OrbState } from './state'
import { orbHit } from '../main/window-hit'
import type { ChatSnapshot } from '../shared/chat'
import { voiceModeDescription, voiceModeLabel } from '../shared/voice'
import { ActivityVisibility, shouldRevealForSnapshot } from './activity-policy'
import { stackTop } from './chat-layout'
import { nearTranscriptBottom, TranscriptHistory } from './transcript'
import { isRoutineVoiceNotice } from './voice-notice'

declare global { interface Window { orb?: {
  hit(inside: boolean): void
  chrome(visible: boolean): void
  geometry(value: {controls:{x:number;y:number;width:number;height:number};captions:{x:number;y:number;width:number;height:number};input:{x:number;y:number;width:number;height:number};menu:{x:number;y:number;width:number;height:number}}): void
  onReveal(callback: () => void): void
  drag(action: 'start' | 'move' | 'end', x?: number, y?: number): void
  hide(): void
  submit(text: string): void
  textActivity(hasDraft: boolean): void
  stop(): void
  approval(id: string, choice: 'once' | 'deny'): void
  newConversation(): void
  recover(): void
  restartVoice(): void
  toggleInput(): void
  dismiss(): void
  voiceMode(): void
  enrollVoice(): void
  voiceActivation(): void
  mute(): void
  ptt(down: boolean): void
  voicePreview(): void
  dismissReminder(id: string): void
  onChat(callback: (snapshot: ChatSnapshot) => void): () => void
  onVisible(callback: (visible: boolean) => void): void
} } }

const root = document.getElementById('app')!
const transcript = new TranscriptHistory()
let assistant = { name: 'Megan', wakePhrase: 'Hey Megan', user: 'You' }
const transcriptNodes = new Map<string, { article: HTMLElement; prompt: HTMLElement; reply: HTMLElement }>()
const activity = new ActivityVisibility(visible => { root.classList.toggle('chrome-active', visible); if (!visible) { if (root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur(); setMenu(false) }; window.orb?.chrome(visible) })
const reveal = () => activity.reveal()
window.orb?.onReveal(reveal)
window.addEventListener('pointermove', reveal)
window.addEventListener('keydown', event => { if (!event.repeat && !['Shift','Control','Alt','Meta'].includes(event.key)) reveal() })
const stage = document.createElement('div'); stage.className = 'orb-stage'; root.append(stage)
const orb = createOrb(stage)
const controls = document.createElement('div'); controls.className = 'orb-controls'; stage.append(controls)
const settings = document.createElement('button'); settings.className='settings-trigger'; settings.textContent='⚙'; settings.title='Settings'; settings.setAttribute('aria-label','Settings'); settings.setAttribute('aria-expanded','false'); settings.setAttribute('aria-controls','secondary-menu'); controls.append(settings)
let voiceButton: HTMLButtonElement, holdButton: HTMLButtonElement
for (const name of ['Text','Voice','Hold','Hide']) {
  const button = document.createElement('button'); button.textContent = name; button.title = name
  if (name === 'Hide') button.addEventListener('click', () => window.orb?.hide())
  else if (name === 'Text') { button.title = 'Text (Ctrl+Shift+Space)'; button.addEventListener('click', () => { reveal(); window.orb?.toggleInput() }) }
  else if (name === 'Voice') {
    voiceButton = button; button.dataset.action = 'voice-mode'; button.textContent = 'Off'
    button.setAttribute('aria-label', 'Off. Voice and audio capture are off. Next: PTT. Ctrl+Alt+M is emergency Off.')
    button.title = button.getAttribute('aria-label')!
    button.addEventListener('click', () => window.orb?.voiceMode())
    button.addEventListener('contextmenu', event => { event.preventDefault(); window.orb?.voicePreview() })
  }
  else if (name === 'Hold') {
    holdButton = button; button.title = 'Hold with mouse, Space or Enter to record; release to transcribe locally'
    button.addEventListener('pointerdown', event => { if (event.button !== 0) return; activity.setPinned(true); button.setPointerCapture(event.pointerId); window.orb?.ptt(true) })
    button.addEventListener('pointerup', () => { window.orb?.ptt(false); activity.setPinned(false) })
    button.addEventListener('lostpointercapture', () => { window.orb?.ptt(false); activity.setPinned(false) })
    button.addEventListener('pointercancel', () => { window.orb?.stop(); activity.setPinned(false) })
    button.addEventListener('keydown', event => { if (['Space', 'Enter'].includes(event.code) && !event.repeat) { event.preventDefault(); activity.setPinned(true); window.orb?.ptt(true) } })
    button.addEventListener('keyup', event => { if (['Space', 'Enter'].includes(event.code)) { event.preventDefault(); window.orb?.ptt(false); activity.setPinned(false) } })
    window.addEventListener('blur', () => { window.orb?.ptt(false); activity.setPinned(false) })
  }
  else { button.disabled = true; button.title = `${name} is available in a later milestone` }
  controls.append(button)
}
const chatStack = document.createElement('div'); chatStack.className = 'chat-stack'; root.append(chatStack)
const captions = document.createElement('div'); captions.className = 'captions'; chatStack.append(captions)
const transcriptScroll = document.createElement('div'); transcriptScroll.className = 'transcript-scroll'; transcriptScroll.tabIndex = 0; transcriptScroll.setAttribute('role', 'region'); transcriptScroll.setAttribute('aria-label', 'Conversation transcript'); captions.append(transcriptScroll)
const reminderList = document.createElement('div'); reminderList.className = 'reminder-list'; reminderList.hidden = true; transcriptScroll.append(reminderList)
const shownReminders = new Set<string>()
function chime() {
  try {
    const audio = new AudioContext(), start = audio.currentTime
    for (const [i, freq] of [880, 1320].entries()) {
      const tone = audio.createOscillator(), gain = audio.createGain()
      tone.frequency.value = freq; gain.gain.setValueAtTime(0.0001, start + i * .18)
      gain.gain.exponentialRampToValueAtTime(.18, start + i * .18 + .02); gain.gain.exponentialRampToValueAtTime(.0001, start + i * .18 + .4)
      tone.connect(gain).connect(audio.destination); tone.start(start + i * .18); tone.stop(start + i * .18 + .45)
    }
    setTimeout(() => void audio.close(), 1000)
  } catch { /* audio is optional */ }
}
function renderReminders(items: NonNullable<ChatSnapshot['reminders']>) {
  reminderList.replaceChildren(...items.map(item => {
    const entry = document.createElement('article'); entry.className = 'reminder'
    const title = document.createElement('strong'); title.textContent = item.title
    const message = document.createElement('p'); message.textContent = item.message
    entry.append(title, message)
    if (item.url) { const link = document.createElement('p'); link.className = 'reminder-url'; link.textContent = item.url; entry.append(link) }
    const done = document.createElement('button'); done.textContent = 'Got it'; done.addEventListener('click', () => window.orb?.dismissReminder(item.id))
    entry.append(done)
    return entry
  }))
  reminderList.hidden = !items.length
  if (items.some(item => !shownReminders.has(item.id))) chime()
  shownReminders.clear(); for (const item of items) shownReminders.add(item.id)
}
const transcriptList = document.createElement('div'); transcriptList.className = 'transcript-list'; transcriptScroll.append(transcriptList)
const transcriptNotice = document.createElement('div'); transcriptNotice.className = 'transcript-notice'; transcriptScroll.append(transcriptNotice)
const sessionControls = document.createElement('div'); sessionControls.className = 'session-controls'; sessionControls.id='secondary-menu'; sessionControls.setAttribute('role','group'); sessionControls.setAttribute('aria-label','Settings'); sessionControls.hidden=true; root.append(sessionControls)
let menuOpen=false
function setMenu(open:boolean){menuOpen=open;sessionControls.hidden=!open;settings.setAttribute('aria-expanded',String(open));if(open)activity.reveal();requestAnimationFrame(reportGeometry)}
settings.addEventListener('click',()=>setMenu(!menuOpen))
document.addEventListener('pointerdown',e=>{if(menuOpen&&!sessionControls.contains(e.target as Node)&&e.target!==settings)setMenu(false)})
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&menuOpen){setMenu(false);settings.focus()}})

window.addEventListener('resize',()=>reportGeometry())
function reportGeometry(){chatStack.style.top=`${stackTop(controls.getBoundingClientRect())}px`;const rect=(el:HTMLElement)=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};window.orb?.geometry({controls:rect(controls),captions:captions.hidden?{x:0,y:0,width:0,height:0}:rect(captions),input:inputForm.hidden?{x:0,y:0,width:0,height:0}:rect(inputForm),menu:sessionControls.hidden?{x:0,y:0,width:0,height:0}:rect(sessionControls)})}
const newButton = document.createElement('button'); newButton.textContent = 'New conversation'; newButton.title = 'Cancel active run and start a fresh conversation only after confirmation'; newButton.addEventListener('click', () => window.orb?.newConversation())
const recoverButton = document.createElement('button'); recoverButton.textContent = 'Check run'; recoverButton.hidden = true; recoverButton.addEventListener('click', () => window.orb?.recover())
const restartButton = document.createElement('button'); restartButton.textContent = 'Restart local voice'; restartButton.hidden = true; restartButton.addEventListener('click', () => window.orb?.restartVoice())
const enrollButton = document.createElement('button'); enrollButton.textContent = 'Enroll voice'
enrollButton.title = 'Enroll my voice locally. Six short PTT utterances; no audio retained, no enrollment sent to the AI. Positive-only calibration, not authentication.'
let enrolling = false
enrollButton.addEventListener('click', () => {
  reveal()
  if (enrolling) { window.orb?.stop(); return }
  activity.setPinned(true)
  if (window.confirm('Enroll my voice locally? Use only your own voice in a quiet room. Hold Ctrl+Shift+Space or Hold for each of six different short sentences (2–8 seconds); release between samples. The last two are checks. Audio is discarded; only an embedding/calibration profile is saved locally. Enrollment never goes to Megan. This convenience filter is not authentication and cannot measure impostor false acceptance.')) window.orb?.enrollVoice()
  else activity.setPinned(false)
})
sessionControls.append(newButton, recoverButton, restartButton, enrollButton)
const approvalCard = document.createElement('section'); approvalCard.className = 'approval-card'; approvalCard.hidden = true; approvalCard.setAttribute('role', 'dialog'); approvalCard.setAttribute('aria-label', 'Tool approval'); chatStack.append(approvalCard)
const approvalTitle = document.createElement('strong'); approvalTitle.textContent = 'Permission required'
const approvalAction = document.createElement('div'); approvalAction.className = 'approval-action'
const approvalHelp = document.createElement('div'); approvalHelp.className = 'approval-help'
const approvalButtons = document.createElement('div'); approvalButtons.className = 'approval-buttons'
let currentCard: ChatSnapshot['approval']
const approveButton = document.createElement('button'); approveButton.textContent = 'Approve once'; approveButton.dataset.action = 'approve-once'
const denyButton = document.createElement('button'); denyButton.textContent = 'Deny'; denyButton.dataset.action = 'deny'
for (const [button, choice] of [[approveButton, 'once'], [denyButton, 'deny']] as const) button.addEventListener('click', event => {
  if (!event.isTrusted || !currentCard || currentCard.pending) return
  window.orb?.approval(currentCard.id, choice)
})
approvalButtons.append(approveButton, denyButton); approvalCard.append(approvalTitle, approvalAction, approvalHelp, approvalButtons)
captions.setAttribute('role', 'status'); captions.setAttribute('aria-live', 'polite')
function renderTranscript(notice: string, forceBottom = false) {
  const follow = forceBottom || nearTranscriptBottom(transcriptScroll.scrollHeight, transcriptScroll.scrollTop, transcriptScroll.clientHeight)
  const activeIds = new Set(transcript.turns.map(turn => turn.id))
  for (const [id, nodes] of transcriptNodes) if (!activeIds.has(id)) { nodes.article.remove(); transcriptNodes.delete(id) }
  for (const turn of transcript.turns) {
    let nodes = transcriptNodes.get(turn.id)
    if (!nodes) {
      const article = document.createElement('article'); article.className = 'transcript-turn'
      const prompt = document.createElement('p'); prompt.className = 'transcript-prompt'
      const promptRole = document.createElement('strong'); promptRole.textContent = assistant.user
      const promptText = document.createElement('span'); promptText.className = 'transcript-text'
      prompt.append(promptRole, promptText)
      const reply = document.createElement('p'); reply.className = 'transcript-reply'
      const replyRole = document.createElement('strong'); replyRole.textContent = assistant.name
      const replyText = document.createElement('span'); replyText.className = 'transcript-text'
      reply.append(replyRole, replyText)
      article.append(prompt, reply); transcriptList.append(article)
      nodes = { article, prompt: promptText, reply: replyText }; transcriptNodes.set(turn.id, nodes)
    }
    nodes.prompt.textContent = turn.prompt
    nodes.reply.textContent = turn.reply
  }
  transcriptNotice.textContent = notice === 'New conversation.' ? '' : notice
  transcriptNotice.hidden = !transcriptNotice.textContent
  if (follow) transcriptScroll.scrollTop = transcriptScroll.scrollHeight
}
const dismiss = document.createElement('button'); dismiss.className = 'caption-close'; dismiss.textContent = '×'; dismiss.title = 'Dismiss transcript'; dismiss.setAttribute('aria-label', 'Dismiss transcript'); dismiss.addEventListener('pointerdown', event => event.preventDefault()); dismiss.addEventListener('click', () => window.orb?.dismiss()); captions.append(dismiss)
const inputForm = document.createElement('form'); inputForm.className = 'chat-input'; inputForm.hidden = true
const input = document.createElement('input'); input.type = 'text'; input.maxLength = 8000; input.autocomplete = 'off'
function labelInput() { input.placeholder = `Ask ${assistant.name}…`; input.setAttribute('aria-label', `Message ${assistant.name}`) }
labelInput()
const send = document.createElement('button'); send.type = 'submit'; send.textContent = 'Send'
inputForm.append(input, send); chatStack.append(inputForm)
inputForm.addEventListener('submit', event => { event.preventDefault(); if (!input.value.trim() || input.disabled) return; window.orb?.submit(input.value); input.value = '' })
input.addEventListener('input', () => { reveal(); window.orb?.textActivity(input.value.length > 0) })
input.addEventListener('focus', () => { if (input.value) reveal() })
input.addEventListener('keydown', event => { if (event.key === 'Escape') window.orb?.toggleInput() })
window.orb?.onChat(snapshot => {
  if (snapshot.assistant) { assistant = snapshot.assistant; labelInput() }
  const previousInputTop = inputForm.hidden ? 0 : inputForm.getBoundingClientRect().top
  const previousStackShape = `${captions.hidden}:${approvalCard.hidden}:${inputForm.hidden}`
  if (snapshot.transcriptDismissed) transcript.dismiss()
  const transcriptUpdate = snapshot.transcriptDismissed ? { added: false, reset: false } : transcript.apply(snapshot)
  const reminders = snapshot.reminders ?? []
  renderReminders(reminders)
  activity.setPinned(shouldRevealForSnapshot(snapshot) || reminders.length > 0)
  root.dataset.synthetic = String(snapshot.synthetic === true)
  root.dataset.syntheticAudio = String(snapshot.syntheticAudio === true)
  currentCard = snapshot.approval
  approvalCard.hidden = !currentCard
  approvalAction.textContent = currentCard?.action ?? ''
  approvalHelp.textContent = currentCard?.pending ? 'Decision sent; awaiting backend confirmation.' : snapshot.approvalShortcutAvailable ? 'Click once or Ctrl+Alt+Y while this card is focused.' : 'Use the buttons; approval hotkey is unavailable.'
  approveButton.disabled = denyButton.disabled = !!currentCard?.pending || snapshot.stopping
  newButton.disabled = snapshot.stopping
  recoverButton.hidden = !(snapshot.busy && snapshot.state === 'offline')
  restartButton.hidden = !!snapshot.voice?.ready
  const voice = snapshot.voice
  enrolling = !!voice?.enrolling
  enrollButton.disabled = !voice?.ready || !voice.enabled || voice.muted || snapshot.busy || !!voice.speechActive || !['idle', 'listening'].includes(voice.state)
  enrollButton.textContent = enrolling ? `Cancel enrollment ${voice?.enrollmentCount || 0}/6` : voice?.registered ? 'Re-enroll voice' : 'Enroll voice'

  const { state, level } = snapshotVisual(snapshot)
  if (!new URLSearchParams(location.search).has('state')) orb.setState(state)
  orb.setLevel(level)
  root.dataset.chatState = state; root.dataset.busy = String(snapshot.busy)
  root.dataset.voiceMode = String(!!voice?.enabled); root.dataset.voiceReady = String(!!voice?.ready)
  const currentMode = voice?.mode || 'off'
  const nextMode = voiceModeLabel(voice?.nextMode || 'voice')
  voiceButton.disabled = false; voiceButton.textContent = voiceModeLabel(currentMode)
  const modeDescription = voiceModeDescription(currentMode, assistant.wakePhrase)
  const pendingDescription = voice?.pendingMode === 'active' ? ` Voice with ${assistant.wakePhrase} is pending until the local listener is ready; the next action turns it Off.` : ''
  voiceButton.setAttribute('aria-label', `${voiceModeLabel(currentMode)}. ${modeDescription}${pendingDescription} Next: ${nextMode}. Ctrl+Alt+M is emergency Off.`)
  voiceButton.title = voiceButton.getAttribute('aria-label')!
  voiceButton.setAttribute('aria-pressed', String(!!voice?.enabled))
  holdButton.disabled = !voice?.ready || !voice.enabled || voice.muted || (!voice.registered && !voice.enrolling && voice.speakerFilter !== false) || snapshot.busy || !!voice.speechActive || (!voice.followupActive && !['idle', 'listening', 'armed'].includes(voice.state))
  const notice = isRoutineVoiceNotice(snapshot.notice) ? '' : snapshot.notice
  const visible = reminders.length > 0 || !snapshot.transcriptDismissed && (transcript.turns.length > 0 || !!notice && notice !== 'New conversation.')
  captions.classList.toggle('active', visible); captions.hidden = !visible || !!currentCard
  renderTranscript(snapshot.transcriptDismissed ? '' : notice, transcriptUpdate.added || transcriptUpdate.reset)
  const opening = inputForm.hidden && snapshot.inputOpen
  inputForm.hidden = !snapshot.inputOpen
  const stackChanged = previousStackShape !== `${captions.hidden}:${approvalCard.hidden}:${inputForm.hidden}`
  root.classList.toggle('has-output', visible || !!currentCard)
  input.disabled = snapshot.busy; send.disabled = snapshot.busy
  if (opening) { reveal(); input.focus() }
  requestAnimationFrame(()=>{reportGeometry();if(stackChanged&&previousInputTop&&!inputForm.hidden){const next=inputForm.getBoundingClientRect().top,delta=previousInputTop-next;if(delta){const duration=matchMedia('(prefers-reduced-motion: reduce)').matches?1:220;inputForm.animate([{transform:`translateY(${delta}px)`},{transform:'translateY(0)'}],{duration,easing:'ease-out'});const until=performance.now()+duration+20;const track=()=>{reportGeometry();if(performance.now()<until)requestAnimationFrame(track)};track()}}})
})
let dragging = false, hit = false
stage.addEventListener('mousemove', event => {
  reveal()
  if (dragging) {window.orb?.drag('move', event.screenX, event.screenY);return}
  const inside = orbHit({x:event.clientX,y:event.clientY},{x:0,y:0})
  if (inside !== hit) {hit=inside;window.orb?.hit(hit)}
})
stage.addEventListener('mouseleave', () => {if(!dragging){hit=false;window.orb?.hit(false)}})
stage.addEventListener('mousedown', event => {if (event.button!==0 || !orbHit({x:event.clientX,y:event.clientY},{x:0,y:0}) || (event.target as HTMLElement).closest('button'))return;dragging=true;window.orb?.drag('start',event.screenX,event.screenY)})
window.addEventListener('mousemove', event => {if(dragging)window.orb?.drag('move',event.screenX,event.screenY)})
window.addEventListener('mouseup', () => {if(!dragging)return;dragging=false;window.orb?.drag('end');hit=false;window.orb?.hit(false)})
window.orb?.onVisible(value => orb.setVisible(value))

// Explicit dev previews remain independent of live chat state.
const preview = new URLSearchParams(location.search)
const name = preview.get('state') as OrbState
if (STATES.includes(name)) orb.setState(name)
orb.setLevel(Number(preview.get('level') || 0))
