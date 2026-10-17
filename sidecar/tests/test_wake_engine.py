import asyncio
import numpy as np
import pytest
from engine import Engine
from test_engine import Models, Audio, AcceptedFilter


class FeedAudio(Audio):
    def start_feed(self, callback):
        self.callback = callback
        self.listening = True
    def feed(self, count=1, value=.1):
        for _ in range(count):
            self.callback(np.full(800, value, dtype=np.float32), False)


class Detector:
    def __init__(self): self.calls = 0
    def reset(self): self.calls = 0
    def feed(self, pcm):
        self.calls += 1
        return self.calls == 4


class WakeModels(Models):
    def trim(self, pcm): return pcm[np.abs(pcm) > .01]
    def transcribe(self, pcm, trimmed=False): return 'Hey Megan, tell me about Hey Megan tomorrow.'


def fixture(speaker=None):
    events, audio = [], FeedAudio()
    engine = Engine(WakeModels(), audio, events.append, speaker or AcceptedFilter(), wake_factory=Detector)
    return engine, audio, events


async def settle(predicate, limit=300):
    for _ in range(limit):
        if predicate(): return
        await asyncio.sleep(.01)
    assert predicate(), 'timed out'


def test_opt_in_capture_verifies_combined_audio_and_removes_only_prefix():
    async def run():
        e, a, events = fixture()
        assert not a.listening and not e.activation
        await e.command({'type': 'mode', 'enabled': True})
        await e.command({'type': 'activation', 'enabled': True})
        await settle(lambda: a.listening)
        a.feed(4)
        await settle(lambda: e.state == 'capturing')
        a.feed(30)
        await settle(lambda: e.wake_queue is None or e.wake_queue.empty())
        for _ in range(4):
            a.feed(20, 0)
            await settle(lambda: e.wake_queue is None or e.wake_queue.empty())
        await settle(lambda: any(x['type'] == 'transcript' for x in events))
        assert [x['text'] for x in events if x['type'] == 'transcript'] == ['tell me about Hey Megan tomorrow.']
        assert not a.listening  # await main's pause/resume, never open between submit and busy
        await e.command({'type': 'pause', 'paused': False})
        await settle(lambda: a.listening)
        await e.command({'type': 'activation', 'enabled': False})
        await e.wait()
        assert not a.listening and not e.activation
    asyncio.run(run())


@pytest.mark.parametrize('control', [{'type':'mute','muted':True}, {'type':'mode','enabled':False}, {'type':'cancel'}])
def test_off_mute_stop_flushes_capture_and_ignores_stale_callbacks(control):
    async def run():
        e, a, events = fixture()
        await e.command({'type':'mode','enabled':True})
        await e.command({'type':'activation','enabled':True})
        await settle(lambda: a.listening)
        callback = a.callback
        await e.command(control)
        callback(np.ones(800,dtype=np.float32), False)
        await e.wait()
        assert not a.listening and not e.activation
        assert e.detector is not None  # kept loaded; reset on the next arm
        assert not any(x['type']=='transcript' for x in events)
    asyncio.run(run())


def test_rearm_reuses_the_loaded_detector_and_resets_it():
    async def run():
        created = []
        def factory():
            created.append(Detector())
            return created[-1]
        events, audio = [], FeedAudio()
        e = Engine(WakeModels(), audio, events.append, AcceptedFilter(), wake_factory=factory)
        await e.command({'type': 'mode', 'enabled': True})
        await e.command({'type': 'activation', 'enabled': True})
        await settle(lambda: audio.listening)
        audio.feed(2)
        await e.command({'type': 'activation', 'enabled': False})
        await e.wait()
        await e.command({'type': 'activation', 'enabled': True})
        await settle(lambda: audio.listening)
        assert len(created) == 1 and created[0].calls == 0
        await e.command({'type': 'cancel'})
        await e.wait()
    asyncio.run(run())
