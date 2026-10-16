"""Explicit local-only probe. Generated PCM stays in memory; no device opens."""
import asyncio
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from voice import LocalModels
from wake import WakeDetector, WakeCapture
from speaker import VoiceFilter, Enrollment
from engine import Engine

ROOT = Path(__file__).resolve().parents[2]


def fixture_speech(models, text):
    # Deterministic input fixture, not a change to accepted runtime Amy tuning.
    from piper import PiperVoice, SynthesisConfig
    if models.piper is None:
        models.piper = PiperVoice.load(models.root / 'amy/en_US-amy-medium.onnx')
    parts = list(models.piper.synthesize(text, syn_config=SynthesisConfig(
        length_scale=.7, noise_scale=0, noise_w_scale=0, volume=.65)))
    return np.concatenate([p.audio_float_array for p in parts]), 22050


def resample(pcm, rate):
    return np.interp(np.arange(int(len(pcm) * 16000 / rate)) * rate / 16000,
                     np.arange(len(pcm)), pcm).astype(np.float32)


def chunks(audio):
    # Endpoint fixture silence is never used to satisfy speaker duration: the
    # production VoiceFilter VAD-trims and enforces its unchanged 1.5s minimum.
    a = np.concatenate([np.zeros(8000, dtype=np.float32), audio, np.zeros(80000, dtype=np.float32)])
    for i in range(0, len(a) - 799, 800):
        yield a[i:i + 800]


async def main():
    import socket
    def deny(*args, **kwargs):
        raise AssertionError('No network permitted in the local model probe')
    socket.socket.connect = socket.socket.connect_ex = socket.create_connection = deny
    models = LocalModels(ROOT / 'sidecar/models')
    detector = WakeDetector(models.root / 'wake')
    phrase = resample(*fixture_speech(models, 'Hey Megan, please tell me a short story about a friendly robot.'))
    for name, audio, expected in [('Hey Megan + immediate command', phrase, True),
                                  ('non-wake speech', resample(*fixture_speech(models, 'Please tell me a short story about a friendly robot.')), False),
                                  ('noise only', np.random.default_rng(7).normal(0,.001,48000).astype(np.float32), False)]:
        detector.reset()
        hits = sum(detector.feed(block) for block in chunks(audio))
        print('KWS', name, 'HEY_MEGAN hits', hits, flush=True)
        assert bool(hits) == expected
    voice = VoiceFilter(models, ROOT / '.cache/m6-no-persist-profile.json')
    enrollment = Enrollment()
    for text in ['The amber light shines across the quiet garden.',
                 'Please place the amber notebook beside the window.',
                 'An amber sunrise fills the room this morning.',
                 'I will read another sentence about an amber planet.',
                 'Keep the amber lantern on the wooden table.',
                 'Please tell me about the amber planet in the garden.']:
        _, embedding = voice.analyze(resample(*fixture_speech(models, text)), True)
        profile = enrollment.add(embedding)
    voice.profile = profile  # synthetic only; never persisted, never the user's real profile
    events, played = [], []
    class SilentAudio:
        listening = False
        def start_feed(self, callback): self.callback = callback; self.listening = True
        def cancel(self): self.listening = False
        def play(self, pcm, rate, cancelled, level):
            assert not self.listening
            played.append(len(pcm)); level(.1)
    audio = SilentAudio()
    engine = Engine(models, audio, events.append, voice, wake_factory=lambda: detector)
    await engine.command({'type': 'mode', 'enabled': True})
    await engine.command({'type': 'activation', 'enabled': True})
    for _ in range(1000):
        if audio.listening: break
        await asyncio.sleep(.01)
    assert audio.listening, events
    for block in chunks(phrase):
        if not audio.listening: break
        audio.callback(block.copy(), False)
        await asyncio.sleep(.01)
    for _ in range(3000):
        if any(e['type'] == 'transcript' for e in events): break
        await asyncio.sleep(.01)
    transcripts = [e['text'] for e in events if e['type'] == 'transcript']
    print('PIPELINE', transcripts, 'device', models.device, flush=True)
    assert len(transcripts) == 1, events
    assert 'friendly robot' in transcripts[0].lower() and not transcripts[0].lower().startswith('hey megan')
    assert not audio.listening
    await engine.command({'type':'pause','paused':True})
    await engine.command({'type':'speech-begin','stream':'mock-reply'})
    await engine.command({'type':'speech-append','stream':'mock-reply','seq':0,'text':'This is a local mock reply about a friendly robot. Hey Megan.'})
    await engine.command({'type':'speech-finish','stream':'mock-reply'})
    await engine.wait()
    assert played and not audio.listening
    assert len([e for e in events if e['type']=='transcript']) == 1
    await engine.command({'type':'activation','enabled':False})
    await engine.wait()
    assert not engine.activation and not audio.listening
    wake_phrase = resample(*fixture_speech(models, 'Hey Megan.'))
    command = resample(*fixture_speech(models, 'Please tell me a short story about a friendly robot.'))
    # A bare wake phrase waits ONSET_FLOOR_SAMPLES (2 s) for the command to begin.
    for pause_ms in (600, 1500):
        before = len([e for e in events if e['type'] == 'transcript'])
        delayed = np.concatenate([wake_phrase, np.zeros(pause_ms * 16, dtype=np.float32), command])
        detector.reset()
        capture = WakeCapture(detector, models.trim)
        combined = None
        for block in chunks(delayed):
            combined = capture.feed(block)
            if combined is not None:
                break
        assert combined is not None, 'Delayed command must actually wake and reach VAD endpoint'
        assert capture.elapsed <= 16000 * 20
        await engine.transcribe(combined, engine.generation, wake=True)
        transcripts = [e['text'] for e in events if e['type'] == 'transcript']
        print(f'DELAYED {pause_ms}ms PIPELINE', transcripts[-1], 'post-hit seconds', capture.elapsed / 16000, flush=True)
        assert len(transcripts) == before + 1 and 'friendly robot' in transcripts[-1].lower()
        assert 'hey megan' not in transcripts[-1].lower()
    await engine.transcribe(resample(*fixture_speech(models, 'Hey Megan.')), engine.generation, wake=True)
    assert len([e for e in events if e['type'] == 'transcript']) == 3, 'Wake alone must not submit'
    print('PASS KWS + VAD + speaker + Whisper + Piper silent sink, same process; mock reply only; no mic/audio files/profile writes.', flush=True)


if __name__ == '__main__':
    asyncio.run(main())
