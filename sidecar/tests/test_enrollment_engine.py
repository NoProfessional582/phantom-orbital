import asyncio
import numpy as np
from engine import Engine
from test_engine import Audio, Models


class Filter:
    profile = None
    notice = ''
    def analyze(self, pcm, enrolling=False):
        return pcm, np.r_[1., np.zeros(255)]
    def accept(self, embedding):
        return self.profile is not None
    def commit(self, profile):
        self.profile = profile


def test_enrollment_uses_six_ptt_releases_never_transcribes_or_emits_user_text():
    class NoTranscription(Models):
        def transcribe(self, pcm):
            raise AssertionError('Enrollment must never reach STT')
    async def run():
        audio, events, filt = Audio(), [], Filter()
        engine = Engine(NoTranscription(), audio, events.append, filt)
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'enroll'})
        assert not audio.listening
        for i in range(6):
            await engine.command({'type': 'start'})
            assert audio.listening
            await engine.command({'type': 'release'})
            await engine.wait()
        assert filt.profile['sample_count'] == 6
        assert not any(e['type'] == 'transcript' for e in events)
        assert events[-1]['registered'] is True
    asyncio.run(run())


def test_rejection_never_transcribes_or_emits_a_user_message():
    class Reject(Filter):
        profile = {'fixture': True}
        def accept(self, embedding):
            return False
    class NoTranscription(Models):
        def transcribe(self, pcm):
            raise AssertionError('Rejected speech must never reach STT')
    async def run():
        events = []
        engine = Engine(NoTranscription(), Audio(), events.append, Reject())
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'start'})
        await engine.command({'type': 'release'})
        await engine.wait()
        assert not any(e['type'] in ('transcript', 'error') for e in events)
        assert 'Nothing sent' in events[-1]['message']
    asyncio.run(run())


def test_off_during_embedding_never_commits_and_requires_deliberate_reenrollment():
    import threading
    entered, release = threading.Event(), threading.Event()
    class Slow(Filter):
        def analyze(self, pcm, enrolling=False):
            entered.set()
            release.wait(2)
            return super().analyze(pcm, enrolling)
        def commit(self, profile):
            raise AssertionError('Stale enrollment cannot persist')
    async def run():
        filt, events, audio = Slow(), [], Audio()
        engine = Engine(Models(), audio, events.append, filt)
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'enroll'})
        await engine.command({'type': 'start'})
        await engine.command({'type': 'release'})
        await asyncio.to_thread(entered.wait, 1)
        await engine.command({'type': 'mode', 'enabled': False})
        release.set()
        await engine.wait()
        assert engine.enrollment is None and filt.profile is None and not audio.listening
        assert not any(e['type'] == 'transcript' for e in events)
        await engine.command({'type': 'mode', 'enabled': True})
        assert engine.enrollment is None and not audio.listening
    asyncio.run(run())


def test_missing_model_error_is_visible_and_enrollment_can_retry():
    from speaker import SpeakerError
    class Missing(Filter):
        def analyze(self, pcm, enrolling=False):
            raise SpeakerError('Speaker model missing. Run scripts/setup-models.ps1 -Download.')
    async def run():
        events = []
        engine = Engine(Models(), Audio(), events.append, Missing())
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'enroll'})
        await engine.command({'type': 'start'})
        await engine.command({'type': 'release'})
        await engine.wait()
        assert engine.state == 'idle' and engine.enrollment is not None
        assert 'setup-models' in events[-1]['message']
        assert not any(e['type'] == 'transcript' for e in events)
    asyncio.run(run())


def test_profile_write_failure_abandons_enrollment_and_visibly_offers_retry():
    class Unwritable(Filter):
        def commit(self, profile):
            raise OSError('fixture disk error')
    async def run():
        events, filt = [], Unwritable()
        engine = Engine(Models(), Audio(), events.append, filt)
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'enroll'})
        for i in range(6):
            await engine.command({'type': 'start'})
            await engine.command({'type': 'release'})
            await engine.wait()
        assert engine.state == 'idle' and engine.enrollment is None
        assert 'could not be saved' in events[-1]['message']
        assert filt.profile is None
    asyncio.run(run())
