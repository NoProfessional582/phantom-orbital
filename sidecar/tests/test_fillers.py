"""Capture-end fillers: local, cached, concurrent with STT, serialized with replies."""
import asyncio
from engine import Engine
from fillers import PHRASES
from test_engine import Models, Audio, AcceptedFilter
import threading
import numpy as np
import pytest


@pytest.mark.parametrize('source', ['wake', 'followup'])
def test_handsfree_capture_plays_feedback_before_blocked_verification(source):
    from test_wake_engine import FeedAudio, WakeModels, Detector, settle
    from test_followup import feed_frames
    entered, release, played = threading.Event(), threading.Event(), threading.Event()
    class Filter(AcceptedFilter):
        def analyze(self, pcm, enrolling=False):
            entered.set()
            assert release.wait(3)
            return super().analyze(pcm, enrolling)
    class Sink(FeedAudio):
        def play(self, pcm, rate, cancelled, level):
            super().play(pcm, rate, cancelled, level)
            played.set()
    async def run():
        audio, events = Sink(), []
        e = Engine(WakeModels(), audio, events.append, Filter(), wake_factory=Detector)
        await e.command({'type': 'voice-mode', 'mode': 'voice', 'revision': 1})
        await e.filler_prewarm
        try:
            await e.command({'type': 'activation', 'enabled': True} if source == 'wake'
                            else {'type': 'followup', 'id': 'previous'})
            await settle(lambda: audio.listening)
            await feed_frames(audio, 40, .1)
            await feed_frames(audio, 40, 0)
            assert await asyncio.to_thread(entered.wait, 1.5)
            assert await asyncio.to_thread(played.wait, 1.5), 'feedback must not wait for speaker/STT'
            assert len(audio.played) == 1 and not audio.listening
            assert not any(x['type'] == 'transcript' for x in events)
        finally:
            release.set()
            await settle(lambda: any(x['type'] == 'transcript' for x in events))
            e.cancel()
            await e.wait()
        assert len([x for x in events if x['type'] == 'transcript']) == 1
    asyncio.run(run())


def test_capture_end_plays_cached_filler_while_transcription_is_blocked():
    entered, release, played = threading.Event(), threading.Event(), threading.Event()
    class Slow(CountingModels):
        def transcribe(self, pcm):
            entered.set()
            assert release.wait(3)
            return super().transcribe(pcm)
    class Sink(Audio):
        def play(self, pcm, rate, cancelled, level):
            super().play(pcm, rate, cancelled, level)
            played.set()
    async def run():
        models, audio, events = Slow(), Sink(), []
        e = Engine(models, audio, events.append, AcceptedFilter())
        await e.command({'type': 'voice-mode', 'mode': 'voice', 'revision': 1})
        await e.filler_prewarm
        try:
            assert sorted(models.spoken) == sorted(PHRASES)
            await e.command({'type': 'start'})
            await e.command({'type': 'release'})
            await e.command({'type': 'release'})
            assert await asyncio.to_thread(entered.wait, 1.5)
            assert await asyncio.to_thread(played.wait, 1.5), 'filler must play before STT returns'
            assert len(audio.played) == 1
            assert len(models.spoken) == len(PHRASES), 'capture path must not synthesize'
            assert not any(x['type'] == 'transcript' for x in events)
        finally:
            release.set()
            await e.wait()
        assert len([x for x in events if x['type'] == 'transcript']) == 1
    asyncio.run(run())



class CountingModels(Models):
    def __init__(self):
        self.spoken = []
    def synthesize(self, text):
        self.spoken.append(text)
        return super().synthesize(text)


def engine():
    models, audio, events = CountingModels(), Audio(), []
    return Engine(models, audio, events.append, AcceptedFilter()), models, audio, events


def test_filler_waits_one_second_after_capture_without_blocking_transcription():
    async def run():
        e, _, audio, events = engine()
        await e.command({'type': 'voice-mode', 'mode': 'voice', 'revision': 1})
        await e.filler_prewarm
        started = asyncio.get_running_loop().time()
        await e.command({'type': 'start'})
        await e.command({'type': 'release'})
        try:
            await asyncio.sleep(.1)
            assert audio.played == [], 'filler must wait after capture ends'
            assert any(x['type'] == 'transcript' for x in events), 'STT must continue during the delay'
            await e.wait()
            assert len(audio.played) == 1
            assert asyncio.get_running_loop().time() - started >= 1.0
        finally:
            e.cancel()
            await e.wait()
    asyncio.run(run())


def test_voice_on_prewarms_every_phrase_once_and_filler_plays_from_cache():
    async def run():
        e, models, audio, events = engine()
        await e.command({'type': 'voice-mode', 'mode': 'voice', 'revision': 1})
        await e.filler_prewarm
        assert sorted(models.spoken) == sorted(PHRASES)
        await e.command({'type': 'start'})
        await e.command({'type': 'release'})
        await e.wait()
        assert len(audio.played) == 1 and len(models.spoken) == len(PHRASES)
        assert not any(x['type'] in ('state', 'error') and x.get('state') == 'speaking' for x in events)
    asyncio.run(run())


def test_filler_messages_cannot_replay_feedback_outside_capture():
    async def run():
        e, _, audio, _ = engine()
        await e.command({'type': 'filler'})  # voice off
        await e.command({'type': 'voice-mode', 'mode': 'voice', 'revision': 1})
        await e.filler_prewarm
        await e.command({'type': 'filler'})  # no capture
        await e.command({'type': 'speech-begin', 'stream': 'reply'})
        await e.command({'type': 'filler'})
        await e.command({'type': 'cancel'})
        await e.wait()
        assert audio.played == []
    asyncio.run(run())


@pytest.mark.parametrize('control', [
    {'type': 'cancel'}, {'type': 'mute', 'muted': True},
    {'type': 'voice-mode', 'mode': 'off', 'revision': 2},
])
def test_stop_off_mute_interrupt_feedback_and_discard_pending_transcript(control):
    entered, transcribing, release = threading.Event(), threading.Event(), threading.Event()
    class Sink(Audio):
        def play(self, pcm, rate, cancelled, level):
            super().play(pcm, rate, cancelled, level)
            entered.set()
            assert cancelled.wait(2)
    class Slow(CountingModels):
        def transcribe(self, pcm):
            transcribing.set()
            assert release.wait(3)
            return 'stale command'
    async def run():
        audio, events = Sink(), []
        e = Engine(Slow(), audio, events.append, AcceptedFilter())
        await e.command({'type': 'voice-mode', 'mode': 'voice', 'revision': 1})
        await e.filler_prewarm
        try:
            await e.command({'type': 'start'})
            await e.command({'type': 'release'})
            assert await asyncio.to_thread(entered.wait, 1.5)
            assert await asyncio.to_thread(transcribing.wait, 1)
            stop = e.filler_stop
            await e.command(control)
            assert stop.is_set()
            await e.command({'type': 'release'})
            await e.command({'type': 'filler'})
        finally:
            release.set()
            await e.wait()
        assert len(audio.played) == 1 and not audio.listening
        assert not any(x['type'] == 'transcript' for x in events)
    asyncio.run(run())


@pytest.mark.parametrize('source', ['empty-ptt', 'silent-ptt', 'enrollment', 'cold-cache', 'rejected'])
def test_noncommands_and_enrollment_are_silent_but_rejected_capture_never_sends_text(source):
    async def run():
        e, models, audio, events = engine()
        await e.command({'type': 'voice-mode', 'mode': 'voice', 'revision': 1})
        await e.filler_prewarm
        if source == 'empty-ptt':
            audio.finish = lambda: np.empty(0, dtype=np.float32)
        elif source == 'silent-ptt':
            audio.finish = lambda: np.zeros(1600, dtype=np.float32)
        elif source == 'enrollment':
            await e.command({'type': 'enroll'})
        elif source == 'cold-cache':
            e.filler_cache.clear()
        elif source == 'rejected':
            e.speaker.accept = lambda embedding: False
        await e.command({'type': 'start'})
        await e.command({'type': 'release'})
        await e.wait()
        assert len(audio.played) == int(source == 'rejected')
        assert len(models.spoken) == len(PHRASES), 'cache miss must skip, not delay capture with TTS'
        if source in ('enrollment', 'rejected'):
            assert not any(x['type'] == 'transcript' for x in events)
    asyncio.run(run())


@pytest.mark.parametrize('source', ['wake', 'followup'])
def test_handsfree_no_command_window_never_plays_feedback(source):
    from test_wake_engine import fixture, settle
    from test_followup import feed_frames
    async def run():
        e, audio, events = fixture()
        await e.command({'type': 'voice-mode', 'mode': 'voice', 'revision': 1})
        await e.filler_prewarm
        try:
            if source == 'wake':
                e.models.transcribe = lambda pcm: 'Hey Megan.'
                await e.command({'type': 'activation', 'enabled': True})
                await settle(lambda: audio.listening)
                await feed_frames(audio, 4, .1)
                await feed_frames(audio, 50, 0)
                await settle(lambda: any('No command' in x.get('message', '') for x in events))
            else:
                await e.command({'type': 'followup', 'id': 'reply'})
                await settle(lambda: audio.listening)
                await feed_frames(audio, 100, 0)
                await settle(lambda: any(x['type'] == 'followup-ended' for x in events))
            assert audio.played == []
            assert not any(x['type'] == 'transcript' for x in events)
        finally:
            e.cancel()
            await e.wait()
    asyncio.run(run())


def test_rejected_wake_cannot_rearm_or_hear_its_own_feedback():
    from test_wake_engine import FeedAudio, WakeModels, Detector, settle
    from test_followup import feed_frames
    entered, release = threading.Event(), threading.Event()
    class Sink(FeedAudio):
        def play(self, pcm, rate, cancelled, level):
            super().play(pcm, rate, cancelled, level)
            entered.set()
            assert release.wait(3)
    async def run():
        speaker, audio, events = AcceptedFilter(), Sink(), []
        speaker.accept = lambda embedding: False
        e = Engine(WakeModels(), audio, events.append, speaker, wake_factory=Detector)
        await e.command({'type': 'voice-mode', 'mode': 'voice', 'revision': 1})
        await e.filler_prewarm
        try:
            await e.command({'type': 'activation', 'enabled': True})
            await settle(lambda: audio.listening)
            callback = audio.callback
            await feed_frames(audio, 40, .1)
            await feed_frames(audio, 40, 0)
            assert await asyncio.to_thread(entered.wait, 1.5)
            await settle(lambda: any('did not match' in x.get('message', '') for x in events))
            e.arm()
            callback(np.ones(800, dtype=np.float32), False)  # closed capture's stale callback
            await asyncio.sleep(.03)
            assert not audio.listening
            assert not any(x['type'] == 'transcript' for x in events)
            release.set()
            await settle(lambda: audio.listening)
            assert len(audio.played) == 1
        finally:
            release.set()
            e.cancel()
            await e.wait()
    asyncio.run(run())


@pytest.mark.parametrize('stop_reply', [False, True])
def test_reply_waits_for_filler_without_blocking_transcription_or_cutting_it_off(stop_reply):
    entered, release, reply = threading.Event(), threading.Event(), threading.Event()
    class Sink(Audio):
        def play(self, pcm, rate, cancelled, level):
            super().play(pcm, rate, cancelled, level)
            if len(self.played) == 1:
                entered.set()
                assert release.wait(3)
            else:
                reply.set()
    async def run():
        audio, events = Sink(), []
        e = Engine(CountingModels(), audio, events.append, AcceptedFilter())
        await e.command({'type': 'voice-mode', 'mode': 'voice', 'revision': 1})
        await e.filler_prewarm
        try:
            await e.command({'type': 'start'})
            await e.command({'type': 'release'})
            assert await asyncio.to_thread(entered.wait, 1.5)
            from test_wake_engine import settle
            await settle(lambda: any(x['type'] == 'transcript' for x in events))
            stop = e.filler_stop
            await e.command({'type': 'speech-begin', 'stream': 'reply'})
            await e.command({'type': 'speech-append', 'stream': 'reply', 'seq': 0, 'text': 'Answer.'})
            await e.command({'type': 'speech-finish', 'stream': 'reply'})
            assert not stop.is_set(), 'speech-begin generation change must preserve feedback'
            assert not await asyncio.to_thread(reply.wait, .1), 'reply must not overlap filler'
            await e.command({'type': 'start'})
            assert not audio.listening
            if stop_reply:
                await e.command({'type': 'cancel'})
                assert stop.is_set()
        finally:
            release.set()
            await e.wait()
        assert reply.is_set() == (not stop_reply)
        assert len(audio.played) == (1 if stop_reply else 2)
    asyncio.run(run())
