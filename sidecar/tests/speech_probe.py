"""Exercise a TS-produced speech payload through frame decoding, engine and sink.

--real uses offline Amy; the sink only checks in-memory PCM, never a device/file.
"""
import asyncio
import json
from pathlib import Path
import struct
import sys

sys.path.insert(0, str(Path(__file__).parents[1]))
import numpy as np
from engine import Engine
from server import read_frame
from voice import LocalModels
from audio_io import LocalAudio


async def probe(message, real=False):
    synthesized, played, samples, events = [], [], [], []
    owners = {}
    if real:
        import socket
        def deny(*args, **kwargs):
            raise AssertionError('Speech attempted a network connection')
        socket.socket.connect = socket.socket.connect_ex = socket.create_connection = deny
    local = LocalModels(Path(__file__).parents[1] / 'models') if real else None
    written = []

    class SilentOutput:
        def __init__(self, **kwargs):
            assert kwargs['samplerate'] == 22050
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def write(self, block):
            assert block.shape[1] == 1
            written.append(len(block))

    class Device:
        OutputStream = SilentOutput

    audio = LocalAudio(Device())

    class Models:
        def synthesize(self, text):
            pcm, rate = local.synthesize(text) if local else (np.ones(100, dtype=np.float32), 22050)
            assert rate == 22050 and len(pcm) > 0 and np.isfinite(pcm).all()
            synthesized.append(text)
            owners[id(pcm)] = text
            return pcm, rate

    class Sink:
        def cancel(self):
            audio.cancel()
        def play(self, pcm, rate, cancelled, level):
            assert not cancelled.is_set()
            written.clear()
            audio.play(pcm, rate, cancelled, level)
            assert sum(written) == len(pcm)
            played.append(owners.pop(id(pcm)))
            samples.append(sum(written))
        def write(self, data):
            pass
        async def drain(self):
            pass

    # JS serialization uses UTF-8, not Python's default ASCII escaping.
    body = json.dumps(message, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    mask = b'abcd'
    header = bytes([0x81, 0x80 | len(body)]) if len(body) < 126 else bytes([0x81, 0xfe]) + struct.pack('!H', len(body))
    reader = asyncio.StreamReader()
    reader.feed_data(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(body)))
    reader.feed_eof()
    sink = Sink()
    engine = Engine(Models(), sink, events.append)
    await engine.command({'type': 'mode', 'enabled': True})
    await engine.command(await read_frame(reader, sink))
    await engine.wait()
    return dict(synthesized=synthesized, played=played, samples=samples, events=events, bytes=len(body))


if __name__ == '__main__':
    message = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    print(json.dumps(asyncio.run(probe(message, '--real' in sys.argv)), ensure_ascii=True))
