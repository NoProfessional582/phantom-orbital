"""Interactive TS→frame decoder→Engine→offline Amy→LocalAudio silent sink.

Only text/events on stdio. No microphone, network, sound device or audio files.
"""
import asyncio
import json
from pathlib import Path
import struct
import sys
import threading

sys.path.insert(0, str(Path(__file__).parents[1]))
import numpy as np
from engine import Engine
from server import read_frame
from voice import LocalModels
from audio_io import LocalAudio


async def main(real=False):
    lock = threading.Lock()
    def emit(event):
        if event['type'] == 'level':
            return
        with lock:
            print(json.dumps(event, ensure_ascii=True), flush=True)
    if real:
        import socket
        def deny(*args, **kwargs):
            raise AssertionError('Speech attempted network access')
        socket.socket.connect = socket.socket.connect_ex = socket.create_connection = deny
    local = LocalModels(Path(__file__).parents[1] / 'models') if real else None
    current = {'text': '', 'samples': 0, 'first': True, 'hold': False}
    resume = threading.Event()

    class Output:
        def __init__(self, **kwargs):
            assert kwargs['samplerate'] == 22050
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def write(self, block):
            assert block.shape[1] == 1 and np.isfinite(block).all()
            current['samples'] += len(block)
            if current['first']:
                current['first'] = False
                emit({'type': 'probe-writer', 'text': current['text']})
            if current['hold']:
                assert resume.wait(10), 'Cancellation did not release sample writer'
    class Device:
        OutputStream = Output
    audio = LocalAudio(Device())
    class Models:
        def synthesize(self, text):
            current.update(text=text, samples=0, first=True)
            emit({'type': 'probe-synthesis', 'text': text})
            return local.synthesize(text) if local else (np.ones(2500, dtype=np.float32), 22050)
    class Sink:
        def cancel(self):
            resume.set()
            audio.cancel()
        def play(self, pcm, rate, cancelled, level):
            assert len(pcm) and np.isfinite(pcm).all()
            audio.play(pcm, rate, cancelled, level)
            if not cancelled.is_set():
                assert current['samples'] == len(pcm)
                emit({'type': 'probe-played', 'text': current['text'], 'samples': len(pcm)})
        def write(self, data): pass
        async def drain(self): pass
    sink = Sink()
    engine = Engine(Models(), sink, emit)
    emit({'type': 'ready'})
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.buffer.readline)
            if not line:
                break
            message = json.loads(line)
            if message['type'] == 'probe-hold':
                current['hold'] = True
                resume.clear()
                continue
            if message['type'] == 'probe-barrier':
                emit({'type': 'probe-barrier'})
                continue
            # Exercise the exact UTF-8 masked-frame decoder, not just Engine.
            body = json.dumps(message, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            mask = b'abcd'
            header = bytes([0x81, 0x80 | len(body)]) if len(body) < 126 else bytes([0x81, 0xfe]) + struct.pack('!H', len(body))
            reader = asyncio.StreamReader()
            reader.feed_data(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(body)))
            reader.feed_eof()
            await engine.command(await read_frame(reader, sink))
    finally:
        engine.cancel()
        await engine.wait()


if __name__ == '__main__':
    asyncio.run(main('--real' in sys.argv))
