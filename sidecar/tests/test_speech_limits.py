import asyncio
import threading
import numpy as np
import pytest
from engine import Engine
from test_engine import Audio, Models


@pytest.mark.parametrize('chunks', [[], ['x' * 401], ['x' * 400] * 41,
                                  ['界' * 400] * 14, ['\\' * 400] * 21, [None], ['']])
def test_invalid_or_oversize_speech_is_visible_and_never_partially_played(chunks):
    async def run():
        audio, events = Audio(), []
        engine = Engine(Models(), audio, events.append)
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'speak', 'chunks': chunks})
        await engine.wait()
        assert not audio.played
        assert {'type': 'speech-rejected'} in events
    asyncio.run(run())


@pytest.mark.parametrize('command', [{'type': 'cancel'}, {'type': 'mute', 'muted': True},
                                    {'type': 'mode', 'enabled': False}])
def test_interrupt_during_synthesis_discards_pcm_and_remaining_chunks(command):
    entered, release = threading.Event(), threading.Event()
    synthesized = []
    class Slow(Models):
        def synthesize(self, text):
            synthesized.append(text)
            entered.set()
            assert release.wait(5)
            return np.ones(100, dtype=np.float32), 22050
    async def run():
        audio, events = Audio(), []
        engine = Engine(Slow(), audio, events.append)
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'speak', 'chunks': ['First sentence.'] * 100})
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            await engine.command(command)
        finally:
            release.set()
            await engine.wait()
        assert synthesized == ['First sentence.']
        assert not audio.played
        assert engine.state == ('muted' if command['type'] == 'mute' else 'idle')
    asyncio.run(run())


def test_replacement_speech_does_not_play_stale_inflight_synthesis():
    entered, release = threading.Event(), threading.Event()
    synthesized, played = [], []
    class Slow:
        def synthesize(self, text):
            synthesized.append(text)
            if text == 'Old.':
                entered.set()
                assert release.wait(5)
            return text, 22050
    class Sink(Audio):
        def play(self, pcm, rate, cancelled, level):
            played.append(pcm)
    async def run():
        engine = Engine(Slow(), Sink(), lambda event: None)
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'speak', 'chunks': ['Old.', 'Stale tail.']})
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            await engine.command({'type': 'speak', 'chunks': ['New.', 'New tail.']})
        finally:
            release.set()
            await engine.wait()
        assert synthesized == ['Old.', 'New.', 'New tail.']
        assert played == ['New.', 'New tail.']
    asyncio.run(run())
