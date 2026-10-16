from pathlib import Path
import threading
import numpy as np


def test_wake_feed_does_not_retain_ptt_frames_and_cancel_invalidates_callback():
    from audio_io import LocalAudio
    streams, received = [], []
    class Stream:
        def __init__(self, **kw): self.kw = kw; self.closed = False; streams.append(self)
        def start(self): pass
        def stop(self): pass
        def close(self): self.closed = True
    audio = LocalAudio(type('SD', (), {'InputStream': Stream}))
    audio.start_feed(lambda pcm, failed: received.append((len(pcm), failed)))
    callback = streams[-1].kw['callback']
    callback(np.ones((800, 1), dtype=np.float32), 800, None, None)
    assert received == [(800, False)] and not audio.frames
    audio.cancel()
    callback(np.ones((800, 1), dtype=np.float32), 800, None, None)
    assert received == [(800, False)] and streams[-1].closed and not audio.frames


def test_capture_exists_only_between_hold_and_release_and_is_bounded():
    assert (Path(__file__).parents[1] / 'audio_io.py').is_file(), 'Audio I/O not implemented'
    from audio_io import LocalAudio
    streams = []
    class Stream:
        def __init__(self, **kw):
            self.kw = kw
            self.closed = False
            streams.append(self)
        def start(self): pass
        def stop(self): pass
        def close(self): self.closed = True
    sd = type('SD', (), {'InputStream': Stream})
    audio = LocalAudio(sd)
    assert not streams
    audio.start(lambda value: None)
    stream = streams[0]
    assert stream.kw['samplerate'] == 16000
    stream.kw['callback'](np.ones((800, 1), np.float32), 800, None, None)
    pcm = audio.finish()
    assert len(pcm) == 800 and stream.closed
    audio.start(lambda value: None)
    for _ in range(602):
        streams[-1].kw['callback'](np.ones((800, 1), np.float32), 800, None, None)
    assert audio.overflowed
    assert len(audio.finish()) == 0  # discard, never submit a silently truncated recording
    audio.cancel()


def test_playback_uses_local_22050_output_and_can_be_cancelled():
    assert (Path(__file__).parents[1] / 'audio_io.py').is_file(), 'Audio I/O not implemented'
    from audio_io import LocalAudio
    writes, levels = [], []
    class Output:
        def __init__(self, **kw):
            assert kw['samplerate'] == 22050
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def write(self, pcm): writes.append(len(pcm))
    audio = LocalAudio(type('SD', (), {'OutputStream': Output}))
    audio.play(np.ones(2205, dtype=np.float32), 22050, threading.Event(), levels.append)
    assert sum(writes) == 2205 and levels
    stop = threading.Event(); stop.set()
    audio.play(np.ones(2205, dtype=np.float32), 22050, stop, levels.append)
    assert sum(writes) == 2205
