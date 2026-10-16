"""UI smoke sidecar: real models, synthetic-only input, silent output.
Never import sounddevice or load/save a household profile.
"""
import asyncio
import json
import os
from pathlib import Path
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import VoiceServer
from speaker import VoiceFilter, Enrollment
from voice import LocalModels
from wake_probe import resample, chunks, ROOT, fixture_speech
import numpy as np


class SyntheticWakeAudio:
    def __init__(self, models):
        self.phrase = list(chunks(resample(*fixture_speech(models, 'Hey Megan, please tell me a short story about a friendly robot.'))))
        self.identity = 0
        self.opens = self.played = 0
        self.listening = False
        self.callback = None

    def start_feed(self, callback):
        self.cancel()
        self.listening = True
        self.callback = callback
        self.opens += 1
        identity = self.identity
        frames = self.phrase if self.opens == 1 else []
        def feed():
            i = 0
            while identity == self.identity:
                callback(frames[i] if i < len(frames) else np.zeros(800, dtype=np.float32), False)
                i += 1
                time.sleep(.05)
        threading.Thread(target=feed, daemon=True).start()

    def cancel(self):
        self.identity += 1
        self.listening = False

    def play(self, pcm, rate, cancelled, level):
        assert not self.listening
        self.played += len(pcm)
        level(.1)
        # An already queued mic callback containing Amy must be discarded.
        for block in chunks(resample(pcm, rate)):
            if self.callback:
                self.callback(block, False)


async def main():
    models = LocalModels(ROOT / 'sidecar/models')
    voice = VoiceFilter(models, ROOT / '.cache/m6-ui-never-written.json')
    enrollment = Enrollment()
    for text in ['The amber light shines across the quiet garden.',
                 'Please place the amber notebook beside the window.',
                 'An amber sunrise fills the room this morning.',
                 'I will read another sentence about an amber planet.',
                 'Keep the amber lantern on the wooden table.',
                 'Please tell me about the amber planet in the garden.']:
        _, embedding = voice.analyze(resample(*fixture_speech(models, text)), True)
        profile = enrollment.add(embedding)
    voice.profile = profile
    audio = SyntheticWakeAudio(models)
    server = VoiceServer(os.environ.pop('ORB_VOICE_TOKEN'), models, lambda: audio, voice)
    listener = await asyncio.start_server(server.handle, '127.0.0.1', 0, limit=16384)
    print(json.dumps({'port':listener.sockets[0].getsockname()[1]}), flush=True)
    await asyncio.to_thread(sys.stdin.buffer.read, 1)

    listener.close()
    await listener.wait_closed()
    if server.engine:
        server.engine.cancel()
        await server.engine.wait()
    assert not audio.listening
    print(json.dumps({'opens':audio.opens,'played':audio.played,'activation':False,'mic':False}),flush=True)



if __name__ == '__main__':
    asyncio.run(main())
