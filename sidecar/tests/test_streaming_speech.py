"""No microphone/device: real LocalAudio sample writer behind an open completion gate."""
import asyncio
import threading
import numpy as np
import pytest
from engine import Engine, SPEECH_FRAME_BYTES
from audio_io import LocalAudio
from test_engine import Audio, Models


@pytest.mark.parametrize('texts', [['x' * 401], ['界' * 400] * 14, ['one'] * 257])
def test_stream_native_chunk_and_total_queue_bounds_refuse_visibly(texts):
    async def run():
        events, audio = [], Audio()
        engine = Engine(Models(), audio, events.append)
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'speech-begin', 'stream': 'bounded'})
        for seq, text in enumerate(texts):
            await engine.command({'type': 'speech-append', 'stream': 'bounded', 'seq': seq, 'text': text})
        await engine.wait()
        assert not audio.played
        assert {'type': 'speech-rejected', 'stream': 'bounded'} in events
    asyncio.run(run())


def test_replacements_cannot_accumulate_unbounded_native_waiters():
    async def run():
        engine = Engine(Models(), Audio(), lambda event: None)
        await engine.command({'type': 'mode', 'enabled': True})
        for n in range(1000):
            await engine.command({'type': 'speech-begin', 'stream': str(n)})
        assert len(engine.tasks) <= 8
        engine.cancel()
        await engine.wait()
    asyncio.run(run())


def test_levels_cannot_starve_control_ack_and_full_control_queue_disconnects():
    import server
    queue = asyncio.Queue(maxsize=256)
    class Writer:
        closed = False
        def close(self): self.closed = True
    writer = Writer()
    for _ in range(1000):
        server.enqueue_event(queue, writer, {'type': 'level', 'value': .5})
    server.enqueue_event(queue, writer, {'type': 'speech-ack', 'stream': 'run', 'seq': 0})
    events = [queue.get_nowait() for _ in range(queue.qsize())]
    assert len(events) <= 129
    assert events[-1]['type'] == 'speech-ack'
    for _ in range(257):
        server.enqueue_event(queue, writer, {'type': 'speech-ack', 'stream': 'run', 'seq': 0})
    assert writer.closed


def test_first_synthesis_and_sample_write_precede_backend_completion():
    async def run():
        order, texts = [], []
        written = threading.Event()
        class Output:
            def __init__(self, **kwargs): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def write(self, block):
                order.append('sample-writer')
                written.set()
        class Device:
            OutputStream = Output
        class Model(Models):
            def synthesize(self, text):
                texts.append(text)
                order.append('synthesis:' + text)
                return super().synthesize(text)
        engine = Engine(Model(), LocalAudio(Device()), lambda event: None)
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'speech-begin', 'stream': 'run-1'})
        order.append('first-text')
        await engine.command({'type': 'speech-append', 'stream': 'run-1', 'seq': 0, 'text': 'First.'})
        try:
            assert await asyncio.to_thread(written.wait, 2), order
            await engine.command({'type': 'start'})
            assert engine.audio.stream is None
            await engine.command({'type': 'speech-append', 'stream': 'run-1', 'seq': 1, 'text': 'Second.'})
            await engine.command({'type': 'speech-append', 'stream': 'run-1', 'seq': 2, 'text': 'Third tail'})
            order.append('backend-completed')
            await engine.command({'type': 'speech-finish', 'stream': 'run-1'})
        finally:
            if not written.is_set(): engine.cancel()
            await engine.wait()
        assert texts == ['First.', 'Second.', 'Third tail']
        assert order.index('sample-writer') < order.index('backend-completed')
    asyncio.run(run())


@pytest.mark.parametrize('command', [{'type': 'cancel'}, {'type': 'mute', 'muted': True}, {'type': 'mode', 'enabled': False}, {'type': 'speech-begin', 'stream': 'replacement'}])
def test_stale_append_cannot_revive_cancelled_or_replaced_stream(command):
    async def run():
        audio, events = Audio(), []
        engine = Engine(Models(), audio, events.append)
        await engine.command({'type': 'mode', 'enabled': True})
        await engine.command({'type': 'speech-begin', 'stream': 'old'})
        await engine.command(command)
        await engine.command({'type': 'speech-append', 'stream': 'old', 'seq': 0, 'text': 'Stale.'})
        await engine.command({'type': 'speech-finish', 'stream': 'old'})
        if command['type'] == 'speech-begin':
            await engine.command({'type': 'speech-finish', 'stream': 'replacement'})
        await engine.wait()
        assert not audio.played
    asyncio.run(run())
