import asyncio
import threading
import numpy as np
import pytest
from speaker import SpeakerError
from test_engine import AcceptedFilter
from test_wake_engine import fixture, settle
from wake import WakeCapture


@pytest.mark.parametrize('text', ['Hey Megan.', 'No command here.', 'Please ask Hey Megan tomorrow.'])
def test_wake_alone_false_wake_and_nonprefix_never_submit(text):
    async def run():
        e, _, events = fixture()
        e.models.transcribe = lambda pcm: text
        await e.transcribe(np.ones(48000,dtype=np.float32), e.generation, wake=True)
        assert not any(x['type']=='transcript' for x in events)
        assert any(x['type']=='speaker' and 'No command' in x['message'] for x in events)
    asyncio.run(run())


def test_wrong_speaker_rejects_before_whisper_and_preserves_threshold():
    class Wrong(AcceptedFilter):
        def accept(self, embedding): return False
    async def run():
        e, _, events = fixture(Wrong())
        def forbidden(pcm): raise AssertionError('Whisper must not run')
        e.models.transcribe = forbidden
        await e.transcribe(np.ones(48000,dtype=np.float32),e.generation,wake=True)
        assert not any(x['type']=='transcript' for x in events)
        assert any('did not match' in x.get('message','') for x in events)
    asyncio.run(run())


def test_insufficient_combined_speech_rejects_before_whisper():
    from speaker import VoiceFilter
    async def run():
        e, _, events = fixture()
        e.speaker = VoiceFilter(e.models, '.cache/m6-unit-nonexistent.json', embed=lambda pcm: np.r_[1.,np.zeros(255)])
        e.speaker.profile = {'threshold':.9,'embedding':np.r_[1.,np.zeros(255)]}
        e.models.transcribe = lambda pcm: (_ for _ in ()).throw(AssertionError('no STT'))
        await e.transcribe(np.r_[np.ones(16000,dtype=np.float32)*.1,np.zeros(32000,dtype=np.float32)], e.generation,wake=True)
        assert not any(x['type']=='transcript' for x in events)
        assert any('too short' in x.get('message','') for x in events)
        assert any('Hey Megan' in x.get('message','') for x in events)
    asyncio.run(run())


def test_cancel_during_speaker_work_never_submits_or_rearms():
    entered, release = threading.Event(), threading.Event()
    class Slow(AcceptedFilter):
        def analyze(self, pcm, enrolling=False):
            entered.set();release.wait(3)
            return super().analyze(pcm,enrolling)
    async def run():
        e, a, events = fixture(Slow())
        task=asyncio.create_task(e.transcribe(np.ones(48000,dtype=np.float32),e.generation,wake=True))
        await asyncio.to_thread(entered.wait,1)
        await e.command({'type':'cancel'})
        release.set();await task
        assert not a.listening and not e.activation
        assert not any(x['type']=='transcript' for x in events)
    asyncio.run(run())


def test_ptt_edges_cannot_steal_an_already_capturing_wake_tail():
    async def run():
        e,a,events=fixture()
        await e.command({'type':'mode','enabled':True})
        await e.command({'type':'activation','enabled':True})
        await settle(lambda:a.listening)
        a.feed(4)
        await settle(lambda:e.state=='capturing')
        await e.command({'type':'start'});await e.command({'type':'release'})
        assert e.state=='capturing' and a.listening
        await e.command({'type':'cancel'});await e.wait()
        assert not any(x['type']=='transcript' for x in events)
    asyncio.run(run())


def test_background_has_bounded_ring_and_does_not_run_vad_before_wake():
    class Quiet:
        def feed(self, pcm):return False
    def forbidden(pcm):raise AssertionError('VAD/STT should not run while armed')
    capture=WakeCapture(Quiet(),forbidden)
    for _ in range(1000):assert capture.feed(np.zeros(800,dtype=np.float32)) is None
    assert len(capture.ring)==60 and capture.frames is None


@pytest.mark.parametrize('pause_frames',[0,12])
def test_immediate_and_short_pause_command_preroll_and_endpoint_are_bounded(pause_frames):
    class Hit:
        def feed(self, pcm):return True
    capture=WakeCapture(Hit(),lambda pcm:pcm[np.abs(pcm)>.01])
    first=np.full(800,.17,dtype=np.float32)
    assert capture.feed(first) is None
    for _ in range(pause_frames):assert capture.feed(np.zeros(800,dtype=np.float32)) is None
    for _ in range(30):assert capture.feed(np.full(800,.2,dtype=np.float32)) is None
    result=None
    for _ in range(100):  # continuous wake+command endpoints after ordinary silence
        result=capture.feed(np.zeros(800,dtype=np.float32))
        if result is not None:break
    assert result is not None and np.array_equal(result[:800],first)
    assert np.count_nonzero(result==.2)==30*800
    assert len(result)<=16000*23


def test_continuous_speech_ends_at_finite_maximum_not_unbounded_capture():
    class Hit:
        def feed(self, pcm):return True
    capture=WakeCapture(Hit(),lambda pcm:pcm)
    capture.feed(np.ones(800,dtype=np.float32))
    result=None
    for _ in range(400):result=capture.feed(np.ones(800,dtype=np.float32))
    assert result is not None and len(result)==401*800


def test_busy_generation_gaps_and_draining_keep_capture_closed_until_finish():
    async def run():
        e,a,events=fixture()
        await e.command({'type':'mode','enabled':True})
        await e.command({'type':'activation','enabled':True})
        await settle(lambda:a.listening)
        stale=a.callback
        await e.command({'type':'pause','paused':True})
        await e.command({'type':'speech-begin','stream':'reply'})
        await asyncio.sleep(.03)
        assert not a.listening and e.speech_stream is not None
        stale(np.ones(800,dtype=np.float32),False)
        await e.command({'type':'pause','paused':False})  # stream still owns gaps
        await asyncio.sleep(.03)
        assert not a.listening
        await e.command({'type':'speech-finish','stream':'reply'})
        await settle(lambda:a.listening)
        assert not any(x['type']=='transcript' for x in events)
        await e.command({'type':'cancel'});await e.wait()
    asyncio.run(run())


def test_missing_or_corrupt_wake_is_visible_without_killing_ptt_engine():
    def missing():raise RuntimeError('model missing')
    async def run():
        e,a,events=fixture();e.wake_factory=missing
        await e.command({'type':'mode','enabled':True})
        await e.command({'type':'activation','enabled':True})
        await settle(lambda:any(x['type']=='wake-error' for x in events))
        assert not a.listening and not e.activation and e.enabled
        await e.command({'type':'start'})
        assert a.listening
        await e.command({'type':'cancel'});await e.wait()
    asyncio.run(run())
