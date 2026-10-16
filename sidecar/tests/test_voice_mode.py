import asyncio
import threading
from test_wake_engine import fixture, settle


def test_atomic_mode_releases_capture_clears_mute_and_rejects_stale_revision():
    async def run():
        e, a, events = fixture()
        e.muted = True
        await e.command({'type': 'voice-mode', 'mode': 'active', 'revision': 1})
        await settle(lambda: a.listening)
        assert e.enabled and e.activation and not e.muted
        assert {'type': 'mode-ready', 'mode': 'active', 'revision': 1} in events
        await e.command({'type': 'voice-mode', 'mode': 'off', 'revision': 2})
        await e.command({'type': 'voice-mode', 'mode': 'active', 'revision': 1})
        await e.wait()
        assert not a.listening and not e.enabled and not e.activation
        assert e.speech_stream is None and e.followup is None
        assert not any(x['type'] == 'transcript' for x in events)
    asyncio.run(run())


def test_busy_active_waits_for_resume_and_missing_model_never_confirms_active():
    async def run():
        e, a, events = fixture()
        e.paused = True
        await e.command({'type': 'voice-mode', 'mode': 'active', 'revision': 1})
        await asyncio.sleep(.03)
        assert not a.listening
        assert not any(x.get('mode') == 'active' for x in events)
        await e.command({'type': 'pause', 'paused': False})
        await settle(lambda: a.listening)
        await e.command({'type': 'voice-mode', 'mode': 'off', 'revision': 2})
        await e.wait()
        def fail(): raise RuntimeError('missing model')
        e.wake_factory = fail
        e.detector = None  # a loaded detector is reused; force a fresh load to exercise the failure
        await e.command({'type': 'voice-mode', 'mode': 'active', 'revision': 3})
        await settle(lambda: any(x['type'] == 'wake-error' for x in events))
        assert not any(x.get('type') == 'mode-ready' and x.get('revision') == 3 and x.get('mode') == 'active' for x in events)
        assert not a.listening
    asyncio.run(run())


def test_off_during_delayed_model_prepare_never_opens_mic_or_confirms_active():
    async def run():
        e, a, events = fixture()
        started, release = threading.Event(), threading.Event()
        from test_wake_engine import Detector
        def delayed():
            started.set()
            assert release.wait(2)
            return Detector()
        e.wake_factory = delayed
        await e.command({'type': 'voice-mode', 'mode': 'active', 'revision': 1})
        await settle(started.is_set)
        await e.command({'type': 'voice-mode', 'mode': 'off', 'revision': 2})
        release.set()
        await e.wait()
        assert not a.listening and not e.enabled and not e.activation
        assert not any(x['type'] == 'mode-ready' and x['mode'] == 'active' for x in events)
    asyncio.run(run())
