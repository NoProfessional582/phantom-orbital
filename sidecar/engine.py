"""PTT state owner. Only accepted text and numeric levels leave this process."""
import asyncio
import json
import threading
import queue
import random
from typing import Any
from speaker import Enrollment, SpeakerError
from persona import Persona, strip_wake

SPEECH_FRAME_BYTES = 16384
SPEECH_CHUNK_CHARACTERS = 400
FILLER_DELAY = 5.0  # seconds after capture ends before a thinking line; a reply arriving first skips it


class Engine:
    filler_delay = FILLER_DELAY

    def __init__(self, models, audio, emit, speaker=None, wake_factory=None, persona=None):
        self.models, self.audio = models, audio
        self.persona = persona or Persona()
        self.mode_revision = 0
        self.emit = lambda event: emit({**event, **({'revision': self.mode_revision} if self.mode_revision else {})})
        self.speaker = speaker
        self.enrollment = None
        self.enabled = False
        self.state = 'idle'
        self.tasks = set()
        self.muted = False
        self.paused = False
        self.generation = 0
        self.cancelled = threading.Event()
        self.inference = asyncio.Lock()
        self.playback = asyncio.Lock()
        self.speech_stream: dict[str, Any] | None = None
        self.activation = False
        self.wake_factory = wake_factory
        self.detector = None
        self.wake_task = None
        self.wake_queue = None
        self.awaiting_response = False
        self.followup = None
        self.filler_stop = threading.Event()
        self.filler_cache = {}
        self.progress_cache = {}
        self.filler_last = None
        self.filler_prewarm = None
        self.filler_waiting = None

    def cancel(self, preserve_activation=False):
        self.followup = None
        self.activation = self.activation and preserve_activation
        if self.filler_waiting:
            self.filler_waiting.set()  # a reply or stop before the delay ends skips the thinking line
        self.wake_queue = None
        if not preserve_activation:
            self.awaiting_response = False  # the loaded wake detector is kept and reset on the next arm
            self.filler_stop.set()  # a reply starting (preserve_activation) lets the filler finish
        if self.speech_stream:
            self.speech_stream['wake'].set()
            self.speech_stream['queue'].clear()
        self.speech_stream = None
        self.generation += 1
        self.enrollment = None
        self.cancelled.set()
        # LocalAudio.cancel closes capture only, not OutputStream playback.
        # A reply changes generation but preserves the filler stop token.
        self.audio.cancel()
        self.level(0)
        self.status('muted' if self.muted else 'idle')
        self.emit({'type': 'cancelled'})
        self.speaker_status()

    def voice_ready(self):
        """Voice input is usable: the speaker filter is off, or a voice is enrolled."""
        return not self.persona.speaker_filter or bool(self.speaker and self.speaker.profile)

    def speaker_status(self, message=''):
        count = len(self.enrollment.samples) if self.enrollment else 0
        self.emit({'type': 'speaker', 'registered': bool(self.speaker and self.speaker.profile),
                   'filter': self.persona.speaker_filter,
                   **({'followup': self.followup} if self.followup else {}),
                   'enrolling': self.enrollment is not None, 'count': count,
                   'message': message or (f'Enrollment {count}/6. Hold PTT for 2–8 seconds. ' +
                   ('Use a different short sentence.' if count < 4 else 'Held-out check: say another short sentence.')
                   if self.enrollment else 'Speaker filter off.' if not self.persona.speaker_filter
                   else 'Voice filter ready.' if self.speaker and self.speaker.profile
                   else 'Not enrolled. Choose Enroll voice; typed text still works.')})

    def status(self, state):
        self.state = state
        self.emit({'type': 'state', 'state': state, **({'followup': self.followup} if self.followup else {})})

    def launch(self, coro):
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        task.add_done_callback(lambda _: asyncio.get_running_loop().call_soon(self.arm))

    async def wait(self):
        if self.tasks:
            await asyncio.gather(*self.tasks)
        if self.wake_task and not self.activation:
            await self.wake_task

    def arm(self):
        if (not (self.activation or self.followup) or not self.enabled or self.muted or self.paused
                or self.enrollment or self.tasks or self.speech_stream or self.awaiting_response
                or self.state not in ('idle', 'armed') or self.wake_task and not self.wake_task.done()):
            return
        self.wake_task = asyncio.create_task(self.listen_wake(self.generation, self.followup))
        self.wake_task.add_done_callback(lambda _: asyncio.get_running_loop().call_soon(self.arm))

    async def listen_wake(self, generation, followup=None):
        from wake import WakeDetector, WakeCapture, FollowupCapture, WakeError, CONTINUOUS_COMMAND_SAMPLES
        pending = queue.Queue(maxsize=40)
        overflow = threading.Event()
        self.wake_queue = pending
        def receive(pcm, failed):
            if self.wake_queue is not pending or generation != self.generation:
                return
            if failed:
                overflow.set()
                return
            try:
                pending.put_nowait(pcm)
            except queue.Full:
                overflow.set()
        capture = None
        try:
            if not followup:
                self.status('arming')
                async with self.inference:
                    if self.detector is None:
                        self.detector = await asyncio.to_thread(self.wake_factory or (lambda: WakeDetector(self.models.root / 'wake', self.persona.wake_phrase)))
                    else:
                        await asyncio.to_thread(self.detector.reset)
            if generation != self.generation or not (self.activation or followup == self.followup and followup) or self.paused:
                return
            capture = (FollowupCapture(self.models.trim, getattr(self.models, 'onset', None)) if followup
                       else WakeCapture(self.detector, self.models.trim))
            self.audio.start_feed(receive)
            if followup:
                self.state = 'followup'
                self.emit({'type': 'state', 'state': 'followup', 'followup': followup})
            else:
                if self.mode_revision:
                    self.emit({'type': 'mode-ready', 'mode': 'active'})
                self.status('armed')
            last_frame = asyncio.get_running_loop().time()
            while generation == self.generation and (self.activation or followup == self.followup and followup) and not self.paused:
                if overflow.is_set() or asyncio.get_running_loop().time() - last_frame > 3:
                    raise WakeError('Wake audio interrupted/overloaded. Enable Voice Activation again.')
                try:
                    block = pending.get_nowait()
                except queue.Empty:
                    await asyncio.sleep(.01)
                    continue
                last_frame = asyncio.get_running_loop().time()
                async with self.inference:
                    pcm = await asyncio.to_thread(capture.feed, block)
                if generation != self.generation:
                    return
                if isinstance(capture, FollowupCapture) and capture.started and self.state == 'followup':
                    self.status('capturing')
                if capture.frames is not None and self.state == 'armed':
                    self.status('capturing')
                if pcm is not None:
                    self.wake_queue = None
                    self.audio.cancel()
                    # Bare wake/onset timeouts are not commands. Direct silence
                    # returns empty PCM; continuous commands can hit the cap.
                    if (followup or capture.onset == 'command'
                            or capture.last_speech >= CONTINUOUS_COMMAND_SAMPLES):
                        self.start_filler(pcm)
                    self.status('verifying')
                    accepted = await self.transcribe(pcm, generation, wake=not followup, followup=followup) if len(pcm) else False
                    if followup and generation == self.generation and not accepted:
                        self.awaiting_response = True  # main resets context before KWS may rearm
                        self.status('idle')
                        self.emit({'type': 'followup-ended', 'id': followup})
                    return
        except Exception as exc:
            if generation == self.generation:
                self.cancel()
                self.emit({'type': 'wake-error', 'message': str(exc) if isinstance(exc, WakeError) else
                           'Local wake unavailable. Check models/audio; enable activation again. No cloud fallback.'})
        finally:
            if self.wake_queue is pending:
                self.wake_queue = None
                self.audio.cancel()
            while not pending.empty():
                pending.get_nowait()
            if capture:
                if isinstance(capture, WakeCapture):
                    capture.ring.clear()
                if capture.frames is not None:
                    capture.frames.clear()

    def level(self, value):
        self.emit({'type': 'level', 'value': max(0., min(1., float(value)))})

    async def command(self, data):
        kind = data.get('type')
        if kind == 'voice-mode':
            mode, revision = data.get('mode'), data.get('revision')
            if mode not in ('off', 'voice', 'active') or type(revision) is not int or revision <= self.mode_revision:
                return
            self.mode_revision = revision
            self.muted = False
            if mode != 'active' or not self.enabled:
                self.cancel()
            self.enabled = mode != 'off'
            self.activation = mode == 'active' and self.voice_ready()
            if (self.enabled and (self.filler_prewarm is None or self.filler_prewarm.done())
                    and (len(self.filler_cache) < len(self.persona.fillers)
                         or len(self.progress_cache) < len(self.persona.progress))):
                self.filler_prewarm = asyncio.create_task(self.prewarm_fillers())
            if mode == 'active' and not self.activation:
                self.emit({'type': 'wake-error', 'message': 'Not enrolled. Choose Enroll voice before Active.'})
            elif self.activation:
                self.arm()
            else:
                self.emit({'type': 'mode-ready', 'mode': mode})
            return
        if kind == 'progress':
            self.start_progress()
            return
        if kind == 'followup':
            identity = data.get('id')
            if (isinstance(identity, str) and 0 < len(identity) <= 128 and self.enabled
                    and not self.muted and not self.enrollment and self.voice_ready()):
                self.followup = identity
                self.awaiting_response = False
                self.arm()
            return
        if kind == 'followup-reset':
            if data.get('id') == self.followup:
                self.followup = None
                self.awaiting_response = False
                self.arm()
            return
        if kind == 'start' and self.followup and not self.paused and not self.speech_stream:
            self.cancel(preserve_activation=True)
        if kind == 'activation':
            if data.get('enabled') is not True:
                self.cancel()
            elif (self.enabled and not self.muted and not self.paused and not self.tasks
                  and self.state == 'idle' and self.voice_ready() and not self.enrollment):
                self.activation = True
                self.emit({'type': 'activation', 'enabled': True})
                self.arm()
            else:
                self.emit({'type': 'wake-error', 'message': 'Voice Activation needs an enrolled voice and idle, unmuted Voice mode.'})
            return
        if kind == 'speech-begin' and self.enabled and not self.muted:
            identity = data.get('stream')
            if not isinstance(identity, str) or not 0 < len(identity) <= 128:
                return
            if self.speech_stream and self.speech_stream['id'] == identity:
                return
            self.cancel(preserve_activation=True)
            if len(self.tasks) >= 8:
                self.emit({'type': 'speech-rejected', 'stream': identity})
                return
            self.cancelled = threading.Event()
            stream = self.speech_stream = dict(id=identity, queue=[], bytes=0, seq=0,
                                               finished=False, wake=asyncio.Event())
            self.launch(self.speak_stream(stream, self.generation, self.cancelled))
            return
        if kind in ('speech-append', 'speech-finish'):
            stream = self.speech_stream
            if not stream or data.get('stream') != stream['id'] or stream['finished']:
                return
            if kind == 'speech-finish':
                stream['finished'] = True
                stream['wake'].set()
                return
            text, seq = data.get('text'), data.get('seq')
            valid = (type(seq) is int and seq == stream['seq'] and isinstance(text, str)
                     and text.strip() and len(text) <= SPEECH_CHUNK_CHARACTERS)
            try:
                size = len(text.encode('utf-8')) if valid else 0
                valid = valid and len(json.dumps(data, ensure_ascii=False).encode('utf-8')) <= SPEECH_FRAME_BYTES
            except UnicodeError:
                valid = False
            if not valid or stream['bytes'] + size > SPEECH_FRAME_BYTES or len(stream['queue']) >= 256:
                identity = stream['id']
                self.cancel()
                self.emit({'type': 'speech-rejected', 'stream': identity})
                return
            stream['queue'].append((seq, text, size))
            stream['seq'] += 1
            stream['bytes'] += size
            stream['wake'].set()
            return
        if kind == 'enroll' and self.enabled and not self.muted and not self.paused and not self.tasks:
            self.cancel()
            self.enrollment = Enrollment()
            self.speaker_status()
        elif kind == 'mode':
            self.enabled = data.get('enabled') is True
            if not self.enabled:
                self.cancel()
        elif kind == 'mute':
            self.muted = data.get('muted') is True
            self.cancel()
        elif kind == 'cancel':
            self.cancel()
        elif kind == 'pause':
            self.paused = data.get('paused') is True
            if self.paused and self.state in ('listening', 'followup', 'arming', 'armed', 'capturing', 'verifying'):
                self.cancel(preserve_activation=True)
            if not self.paused:
                self.awaiting_response = False
                self.arm()
        elif kind == 'speak' and self.enabled and not self.muted:
            chunks = data.get('chunks')
            # Even a one-character JSON string costs four bytes with its separator.
            # This count guard cannot reject a payload that fits the frame budget.
            valid = (isinstance(chunks, list) and 0 < len(chunks) <= SPEECH_FRAME_BYTES // 4
                     and all(isinstance(s, str) and s.strip() and len(s) <= SPEECH_CHUNK_CHARACTERS for s in chunks))
            if valid:
                try:
                    valid = len(json.dumps({'type': 'speak', 'chunks': chunks}, ensure_ascii=False,
                                           separators=(',', ':')).encode('utf-8')) <= SPEECH_FRAME_BYTES
                except UnicodeError:
                    valid = False
            if not valid:
                self.emit({'type': 'speech-rejected'})
                return
            self.cancel(preserve_activation=True)
            self.cancelled = threading.Event()
            self.status('speaking')
            self.launch(self.speak(chunks, self.generation, self.cancelled))
        elif kind == 'start' and self.enabled and not self.muted and not self.paused and not self.speech_stream and self.state in ('idle', 'armed') and not self.tasks:
            if self.activation:
                self.cancel(preserve_activation=True)
            self.audio.start(self.level)
            self.status('listening')
        elif kind == 'release' and self.state == 'listening':
            pcm = self.audio.finish()
            self.start_filler(pcm)
            self.status('transcribing')
            self.launch(self.transcribe(pcm, self.generation))

    async def transcribe(self, pcm, generation, wake=False, followup=None):
        try:
            enrolling = self.enrollment
            async with self.inference:
                if enrolling is None and not self.persona.speaker_filter:
                    # Filter off: any voice is transcribed; transcribe() VAD-trims silence itself.
                    trimmed = pcm
                elif self.speaker is None or (enrolling is None and self.speaker.profile is None):
                    raise SpeakerError('Enroll your voice first. Typed text still works.')
                else:
                    trimmed, embedding = await asyncio.to_thread(self.speaker.analyze, pcm, enrolling is not None)
                if generation != self.generation:
                    return
                if enrolling is not None:
                    profile = enrolling.add(embedding)
                    if profile is not None:
                        self.enrollment = None
                        try:
                            self.speaker.commit(profile)
                        except OSError as exc:
                            raise SpeakerError('Voice profile could not be saved. Choose Enroll voice to retry; typed text still works.') from exc
                    self.status('idle')
                    self.speaker_status('Enrollment saved. Positive-only calibration; not authentication.' if profile else '')
                    return
                if self.persona.speaker_filter and not self.speaker.accept(embedding):
                    self.status('idle')
                    self.speaker_status('Voice did not match. Nothing sent. Retry or enroll again.')
                    return
                text = await asyncio.to_thread(self.models.transcribe, trimmed, trimmed=trimmed is not pcm)
                if wake:
                    text = strip_wake(self.persona.wake_phrase, text)
                    if not text:
                        raise SpeakerError(f'No command after {self.persona.wake_phrase}. Repeat with a longer command; nothing sent.')
            if generation == self.generation:
                self.status('idle')
                if text:
                    if self.activation or followup:
                        self.awaiting_response = True
                    self.emit({'type': 'transcript', 'text': text[:8000], 'device': self.models.device,
                               **({'followup': followup} if followup else {})})
                    return True
        except SpeakerError as exc:
            if generation == self.generation:
                self.status('idle')
                self.speaker_status(f'Speech too short or background only. Say {self.persona.wake_phrase} plus a longer command and retry. Nothing sent.'
                                    if wake and 'too short' in str(exc).lower() else str(exc))
        except Exception:
            if generation == self.generation:
                self.status('error')
                self.emit({'type': 'error', 'message': 'Local transcription failed. No cloud fallback.'})

    async def speak_stream(self, stream, generation, cancelled):
        identity = stream['id']
        played = False
        def status(state):
            if generation == self.generation:
                self.state = state
                self.emit({'type': 'state', 'state': state, 'stream': identity})
        def level(value):
            if not cancelled.is_set():
                self.emit({'type': 'level', 'value': max(0., min(1., float(value))), 'stream': identity})
        try:
            while not cancelled.is_set():
                if not stream['queue']:
                    if stream['finished']:
                        break
                    status('idle')
                    stream['wake'].clear()
                    await stream['wake'].wait()
                    continue
                seq, text, size = stream['queue'][0]
                status('speaking')
                async with self.inference:
                    if cancelled.is_set():
                        return
                    pcm, rate = await asyncio.to_thread(self.models.synthesize, text)
                    if cancelled.is_set():
                        return
                    async with self.playback:
                        if cancelled.is_set():
                            return
                        await asyncio.to_thread(self.audio.play, pcm, rate, cancelled, level)
                if cancelled.is_set():
                    return
                played = played or len(pcm) > 0
                stream['queue'].pop(0)
                stream['bytes'] -= size
                level(0)
                self.emit({'type': 'speech-ack', 'stream': identity, 'seq': seq})
            if generation == self.generation:
                self.speech_stream = None
                status('idle')
                self.emit({'type': 'speech-done', 'stream': identity, 'played': played})
        except Exception:
            if generation == self.generation:
                self.cancel()
                self.status('error')
                self.emit({'type': 'error', 'stream': identity, 'message': 'Local streaming speech failed. Earlier speech may have played.'})

    def filler_audio(self, text, cache=None):
        cache = self.filler_cache if cache is None else cache
        if text not in cache:
            cache[text] = self.models.synthesize(text)
        return cache[text]

    async def prewarm_fillers(self):
        """Synthesize filler and progress lines ahead of time so one plays instantly."""
        try:
            for lines, cache in ((self.persona.fillers, self.filler_cache), (self.persona.progress, self.progress_cache)):
                for text in lines:
                    if text not in cache:
                        async with self.inference:
                            await asyncio.to_thread(self.filler_audio, text, cache)
        except Exception:
            pass  # fillers are optional; a real synthesis failure surfaces on replies

    def start_progress(self):
        """A long wait: play one ready progress line now; never wait for synthesis."""
        # A reply's stream opens before any text; only one that has started speaking blocks this.
        stream = self.speech_stream
        if (not self.enabled or self.muted or self.enrollment or not self.progress_cache
                or stream and (stream['seq'] or stream['queue'])):
            return
        text = random.choice(list(self.progress_cache))
        self.filler_stop = threading.Event()
        self.launch(self.speak_filler(self.progress_cache[text], self.filler_stop, delay=0))

    def start_filler(self, pcm):
        """Capture completion only; use ready audio, never wait for synthesis."""
        if (not self.enabled or self.muted or self.enrollment or self.speech_stream
                or not len(pcm) or not pcm.any() or not self.filler_cache):
            return
        choices = [text for text in self.filler_cache if text != self.filler_last] or list(self.filler_cache)
        text = random.choice(choices)
        self.filler_last = text
        self.filler_stop = threading.Event()
        self.launch(self.speak_filler(self.filler_cache[text], self.filler_stop))

    async def speak_filler(self, audio, stop, delay=None):
        """Delay cached feedback; transcription runs independently and an earlier reply skips it."""
        delay = self.filler_delay if delay is None else delay
        try:
            if delay:
                self.filler_waiting = stop
                try:
                    await asyncio.to_thread(stop.wait, delay)
                finally:
                    if self.filler_waiting is stop:
                        self.filler_waiting = None
            async with self.playback:
                if not stop.is_set():
                    pcm, rate = audio
                    await asyncio.to_thread(self.audio.play, pcm, rate, stop, lambda value: None)
        except Exception:
            pass  # optional; never surface an error for a filler

    async def speak(self, chunks, generation, cancelled):
        try:
            async with self.inference:
                for text in chunks:
                    if cancelled.is_set():
                        break
                    pcm, rate = await asyncio.to_thread(self.models.synthesize, text)
                    if cancelled.is_set():
                        break
                    async with self.playback:
                        if cancelled.is_set():
                            break
                        await asyncio.to_thread(self.audio.play, pcm, rate, cancelled, self.level)
            if generation == self.generation:
                self.level(0)
                self.status('idle')
        except Exception:
            if generation == self.generation:
                self.status('error')
                self.emit({'type': 'error', 'message': 'Local speech failed. No cloud fallback.'})
