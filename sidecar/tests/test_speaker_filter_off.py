import asyncio
import numpy as np
from engine import Engine
from persona import Persona
from test_engine import Audio, Models


class UnusedFilter:
    """An unenrolled filter that must never be consulted while the filter is off."""
    profile = None
    def analyze(self, pcm, enrolling=False):
        raise AssertionError('speaker filter consulted while off')
    def accept(self, embedding):
        raise AssertionError('speaker filter consulted while off')


def test_filter_off_transcribes_short_speech_without_enrollment():
    async def run():
        events = []
        engine = Engine(Models(), Audio(), events.append, UnusedFilter(), persona=Persona(speaker_filter=False))
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'start'})
        await engine.command({'type': 'release'})  # fixture audio is 0.1 s, far below the filter's minimum
        await engine.wait()
        assert {'type': 'transcript', 'text': 'synthetic request', 'device': 'cpu'} in events
        engine.speaker_status()
        speaker = [e for e in events if e['type'] == 'speaker'][-1]
        assert speaker['filter'] is False and speaker['registered'] is False
    asyncio.run(run())


def test_filter_off_allows_activation_and_followup_without_enrollment():
    async def run():
        engine = Engine(Models(), Audio(), [].append, UnusedFilter(), persona=Persona(speaker_filter=False),
                        wake_factory=lambda: None)
        engine.arm = lambda: None  # no microphone in this test
        await engine.command({'type': 'voice-mode', 'mode': 'active', 'revision': 1})
        assert engine.activation is True
        await engine.command({'type': 'followup', 'id': 'reply-1'})
        assert engine.followup == 'reply-1'
    asyncio.run(run())


def test_filter_on_still_requires_enrollment():
    async def run():
        events = []
        engine = Engine(Models(), Audio(), events.append, UnusedFilter(), persona=Persona(speaker_filter=True))
        engine.arm = lambda: None
        await engine.command({'type': 'voice-mode', 'mode': 'active', 'revision': 1})
        assert engine.activation is False
        assert any(e['type'] == 'wake-error' for e in events)
    asyncio.run(run())
