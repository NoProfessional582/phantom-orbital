import asyncio
import numpy as np
import pytest
from wake import FollowupCapture
from test_wake_engine import fixture, settle


def test_silence_expires_at_five_seconds_once():
    capture = FollowupCapture(lambda pcm: pcm[np.abs(pcm) > .01])
    silent = np.zeros(800, dtype=np.float32)
    for _ in range(99):
        assert capture.feed(silent) is None
    assert capture.feed(silent).size == 0


def test_speech_in_last_block_is_not_cut_off_at_deadline():
    capture = FollowupCapture(lambda pcm: pcm[np.abs(pcm) > .01])
    silent, speech = np.zeros(800, dtype=np.float32), np.ones(800, dtype=np.float32)
    for _ in range(99):
        assert capture.feed(silent) is None
    assert capture.feed(speech) is None
    assert capture.started
    for _ in range(50):
        assert capture.feed(speech) is None
    result = None
    for _ in range(40):
        result = capture.feed(silent)
        if result is not None:
            break
    assert result is not None and np.count_nonzero(result) == 51 * 800


def test_continuous_background_is_bounded():
    capture = FollowupCapture(lambda pcm: pcm)
    result = None
    for _ in range(400):
        result = capture.feed(np.ones(800, dtype=np.float32))
        if result is not None:
            break
    assert result is not None and len(result) <= 320000


async def feed_frames(audio, count, value):
    for _ in range(count):
        audio.feed(1, value)
        await asyncio.sleep(.001)


@pytest.mark.parametrize('activation', [False, True])
def test_direct_silence_closes_once_and_does_not_rearm_before_context_reset(activation):
    async def run():
        e, a, events = fixture()
        await e.command({'type': 'mode', 'enabled': True})
        e.activation = activation
        await e.command({'type': 'followup', 'id': 'reply'})
        await settle(lambda: a.listening)
        assert e.state == 'followup'
        await feed_frames(a, 100, 0)
        await settle(lambda: any(x['type'] == 'followup-ended' for x in events))
        assert [x for x in events if x['type'] == 'followup-ended'] == [
            {'type': 'followup-ended', 'id': 'reply'}]
        assert not a.listening
        assert not any(x['type'] == 'transcript' for x in events)
        await e.command({'type': 'followup-reset', 'id': 'reply'})
        if activation:
            await settle(lambda: e.state == 'armed')
        else:
            assert not a.listening
        e.cancel()
        await e.wait()
    asyncio.run(run())


@pytest.mark.parametrize('accepted', [True, False])
def test_direct_transcript_keeps_prefix_and_rejects_nonregistered_speech(accepted):
    async def run():
        e, a, events = fixture()
        e.speaker.accept = lambda embedding: accepted
        await e.command({'type': 'mode', 'enabled': True})
        await e.command({'type': 'followup', 'id': 'reply'})
        await settle(lambda: a.listening)
        await feed_frames(a, 40, .1)
        await feed_frames(a, 36, 0)
        await settle(lambda: any(x['type'] in ('transcript', 'followup-ended') for x in events))
        transcripts = [x for x in events if x['type'] == 'transcript']
        assert len(transcripts) == int(accepted)
        assert all(x.get('followup') == 'reply' for x in events if x['type'] == 'state' and x['state'] in ('followup', 'capturing', 'verifying', 'idle'))
        if accepted:
            assert transcripts[0]['followup'] == 'reply'
            assert transcripts[0]['text'].startswith('Hey Megan,')  # direct speech is not wake-prefixed
        assert not a.listening
        e.cancel()
        await e.wait()
    asyncio.run(run())


@pytest.mark.parametrize('control', [
    {'type': 'cancel'}, {'type': 'mute', 'muted': True},
    {'type': 'mode', 'enabled': False}, {'type': 'start'},
])
def test_direct_capture_control_takes_ownership_and_rejects_old_callback(control):
    async def run():
        e, a, events = fixture()
        await e.command({'type': 'mode', 'enabled': True})
        await e.command({'type': 'followup', 'id': 'reply'})
        await settle(lambda: a.listening)
        callback = a.callback
        await e.command(control)
        callback(np.ones(800, dtype=np.float32), False)
        await asyncio.sleep(.04)
        assert not any(x['type'] in ('transcript', 'followup-ended') for x in events)
        assert a.listening == (control['type'] == 'start')
        e.cancel()
        await e.wait()
    asyncio.run(run())


def test_followup_waits_for_credit_finished_stream_and_unpause():
    async def run():
        e, a, events = fixture()
        await e.command({'type': 'mode', 'enabled': True})
        await e.command({'type': 'pause', 'paused': True})
        await e.command({'type': 'speech-begin', 'stream': 'reply'})
        await e.command({'type': 'followup', 'id': 'reply'})
        await asyncio.sleep(.03)
        assert not a.listening
        await e.command({'type': 'speech-finish', 'stream': 'reply'})
        await settle(lambda: any(x['type'] == 'speech-done' for x in events))
        assert not a.listening
        await e.command({'type': 'pause', 'paused': False})
        await settle(lambda: a.listening)
        e.cancel()
        await e.wait()
    asyncio.run(run())


@pytest.mark.parametrize('samples', [0, 100])
def test_speech_done_reports_actual_sample_playback_not_just_text_credit(samples):
    async def run():
        e, a, events = fixture()
        e.models.synthesize = lambda text: (np.ones(samples, dtype=np.float32), 22050)
        await e.command({'type': 'mode', 'enabled': True})
        await e.command({'type': 'speech-begin', 'stream': 'reply'})
        await e.command({'type': 'speech-append', 'stream': 'reply', 'seq': 0, 'text': 'Reply.'})
        await e.command({'type': 'speech-finish', 'stream': 'reply'})
        await e.wait()
        assert next(x for x in events if x['type'] == 'speech-done')['played'] == bool(samples)
    asyncio.run(run())
