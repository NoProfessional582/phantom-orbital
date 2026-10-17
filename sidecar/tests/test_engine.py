import asyncio
from pathlib import Path
import numpy as np


def runtime():
    assert (Path(__file__).parents[1] / 'engine.py').is_file(), 'PTT engine not implemented'
    from engine import Engine
    return Engine


class Audio:
    def __init__(self):
        self.listening = False
        self.closes = 0
        self.played = []
    def start(self, level):
        self.listening = True
    def finish(self):
        self.listening = False
        return np.ones(1600, dtype=np.float32)
    def cancel(self):
        self.listening = False
        self.closes += 1
    def play(self, pcm, rate, cancelled, level):
        assert not self.listening
        self.played.append((len(pcm), rate))


class Models:
    device = 'cpu'
    def transcribe(self, pcm, trimmed=False):
        return 'synthetic request'
    def synthesize(self, text):
        return np.ones(100, dtype=np.float32), 22050


class AcceptedFilter:
    profile = {'fixture': True}
    def analyze(self, pcm, enrolling=False):
        return pcm, np.r_[1., np.zeros(255)]
    def accept(self, embedding):
        return True


def test_held_record_release_transcribes_only_final_text():
    async def run():
        audio, events = Audio(), []
        engine = runtime()(Models(), audio, events.append, AcceptedFilter())
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'start'})
        assert audio.listening
        await engine.command({'type': 'release'})
        await engine.wait()
        assert not audio.listening
        assert {'type': 'transcript', 'text': 'synthetic request', 'device': 'cpu'} in events
        assert all(not isinstance(v, np.ndarray) for event in events for v in event.values())
    asyncio.run(run())


def test_mute_cancels_pending_transcription_and_releases_mic():
    import threading
    entered, release = threading.Event(), threading.Event()
    class Slow(Models):
        def transcribe(self, pcm, trimmed=False):
            entered.set()
            release.wait(2)
            return 'must not be sent'
    async def run():
        audio, events = Audio(), []
        engine = runtime()(Slow(), audio, events.append, AcceptedFilter())
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'start'})
        await engine.command({'type': 'release'})
        await asyncio.to_thread(entered.wait, 1)
        await engine.command({'type': 'mute', 'muted': True})
        await engine.command({'type': 'start'})
        release.set()
        await engine.wait()
        assert not audio.listening and audio.closes > 0
        assert engine.state == 'muted'
        assert {'type': 'cancelled'} in events
        assert not any(e['type'] == 'transcript' for e in events)
    asyncio.run(run())


def test_speaking_never_listens_and_cancel_interrupts_playback():
    import threading
    entered = threading.Event()
    class Playing(Audio):
        def play(self, pcm, rate, cancelled, level):
            assert not self.listening
            entered.set()
            cancelled.wait(2)
            self.played.append((len(pcm), rate))
    async def run():
        audio, events = Playing(), []
        engine = runtime()(Models(), audio, events.append)
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'speak', 'chunks': ['Synthetic preview.']})
        await asyncio.to_thread(entered.wait, 1)
        assert engine.state == 'speaking'
        await engine.command({'type': 'start'})
        assert not audio.listening
        await engine.command({'type': 'cancel'})
        await engine.wait()
        assert engine.state == 'idle' and len(audio.played) == 1
    asyncio.run(run())
