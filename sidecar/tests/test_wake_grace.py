"""Wake onset grace uses synthetic PCM only, with deterministic VAD."""
import asyncio
import numpy as np
import pytest
from wake import WakeCapture
from test_wake_engine import fixture, settle


class Hit:
    def feed(self, pcm):
        return True


def block(value=0.):
    return np.full(800, value, dtype=np.float32)


def capture_with_tail():
    capture = WakeCapture(Hit(), lambda pcm: pcm[np.abs(pcm) > .01])
    assert capture.feed(block(.17)) is None
    return capture


def endpoint(capture, limit=110):
    for count in range(1, limit + 1):
        result = capture.feed(block())
        if result is not None:
            return result, count
    pytest.fail('capture did not reach a bounded endpoint')


@pytest.mark.parametrize('pause_frames', [8, 16, 24])
def test_wake_tail_then_pause_under_two_seconds_preserves_command(pause_frames):
    capture = capture_with_tail()
    # A real tail persists after the hit as well as in recent[-8:].
    for _ in range(6):
        assert capture.feed(block(.17)) is None
    for _ in range(pause_frames):
        assert capture.feed(block()) is None
    for _ in range(30):
        assert capture.feed(block(.2)) is None
    result, silence_frames = endpoint(capture)
    assert np.count_nonzero(result == .2) == 30 * 800
    assert np.count_nonzero(result == .17) == 7 * 800
    # Existing .4s lookback/.2s cadence plus 1.2s trailing silence.
    assert 24 <= silence_frames <= 32
    assert len(result) <= 16000 * 23


def test_short_continuous_command_endpoints_after_ordinary_silence():
    capture = capture_with_tail()
    for _ in range(30):
        assert capture.feed(block(.2)) is None
    result, silence_frames = endpoint(capture)
    assert capture.elapsed == 48000  # 1.5 s command + trailing silence, not a 5 s floor
    assert 24 <= silence_frames <= 32
    assert np.count_nonzero(result == .2) == 30 * 800


def test_long_continuous_command_endpoints_without_extra_onset_wait():
    capture = capture_with_tail()
    for _ in range(120):
        assert capture.feed(block(.2)) is None
    _, silence_frames = endpoint(capture)
    assert 24 <= silence_frames <= 32


def test_wake_only_finishes_at_two_seconds_even_with_residual_tail():
    capture = capture_with_tail()
    for _ in range(6):
        assert capture.feed(block(.17)) is None
    result, silence_frames = endpoint(capture)
    assert capture.elapsed == 32000 and silence_frames == 34
    assert np.count_nonzero(result) == 7 * 800


@pytest.mark.parametrize('control', [
    {'type': 'cancel'}, {'type': 'activation', 'enabled': False},
    {'type': 'mode', 'enabled': False}, {'type': 'mute', 'muted': True},
])
def test_cancel_off_mute_during_grace_discards_queued_and_stale_audio(control):
    async def run():
        e, a, events = fixture()
        await e.command({'type': 'mode', 'enabled': True})
        await e.command({'type': 'activation', 'enabled': True})
        await settle(lambda: a.listening)
        stale = a.callback
        a.feed(4)
        await settle(lambda: e.state == 'capturing')
        a.feed(20, 0)  # one second: still inside the two-second command window
        await settle(lambda: e.wake_queue is None or e.wake_queue.empty())
        assert a.listening and e.state == 'capturing'
        a.feed(10)  # queued command must also be discarded
        await e.command(control)
        for _ in range(120):
            stale(block(.2), False)
        await e.wait()
        assert not a.listening and not e.activation
        assert e.wake_queue is None
        assert not any(x['type'] == 'transcript' for x in events)
    asyncio.run(run())


def test_wake_only_grace_never_submits_and_keeps_ordinary_rearm():
    async def run():
        e, a, events = fixture()
        e.models.transcribe = lambda pcm, **_: 'Hey Megan.'
        await e.command({'type': 'mode', 'enabled': True})
        await e.command({'type': 'activation', 'enabled': True})
        await settle(lambda: a.listening)
        a.feed(4)
        await settle(lambda: e.state == 'capturing')
        for _ in range(5):
            a.feed(20, 0)
            await settle(lambda: e.wake_queue is None or e.wake_queue.empty())
        await settle(lambda: any('No command' in x.get('message', '') for x in events))
        await settle(lambda: a.listening and e.state == 'armed')
        assert not any(x['type'] == 'transcript' for x in events)
        await e.command({'type': 'cancel'})
        await e.wait()
    asyncio.run(run())
