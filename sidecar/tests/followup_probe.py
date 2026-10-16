"""Explicit in-memory native fixture for the TS lifecycle integration test.

No sounddevice, network, saved audio or real profile. JSON controls over stdio.
"""
import asyncio
import json
from pathlib import Path
import socket
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import Engine
from voice import LocalModels, offline
from wake import WakeDetector
from speaker import VoiceFilter, Enrollment
from wake_probe import fixture_speech, resample, chunks
import numpy as np

ROOT = Path(__file__).resolve().parents[2]


async def main():
    offline()
    def deny(*args, **kwargs):
        raise AssertionError('Native follow-up fixture never uses a network')
    socket.socket.connect = socket.socket.connect_ex = socket.create_connection = deny
    models = LocalModels(ROOT / 'sidecar/models')
    detector = WakeDetector(models.root / 'wake')
    voice = VoiceFilter(models, ROOT / '.cache/followup-nonexistent-profile.json')
    enrollment = Enrollment()
    for text in [
        'The amber light shines across the quiet garden.',
        'Please place the amber notebook beside the window.',
        'An amber sunrise fills the room this morning.',
        'I will read another sentence about an amber planet.',
        'Keep the amber lantern on the wooden table.',
        'Please tell me about the amber planet in the garden.',
    ]:
        _, embedding = voice.analyze(resample(*fixture_speech(models, text)), True)
        profile = enrollment.add(embedding)
    voice.profile = profile  # no commit; never the user's real profile
    wake = list(chunks(resample(*fixture_speech(models, 'Hey Megan, please tell me a short story about a friendly robot.'))))
    direct = list(chunks(resample(*fixture_speech(models, 'Please tell me a short story about a friendly robot.'))))
    silent = [np.zeros(800, dtype=np.float32) for _ in range(100)]
    def emit(event):
        print(json.dumps(event), flush=True)
    class SilentAudio:
        listening = False
        identity = 0
        feeds = 0
        played = 0
        def start_feed(self, receive):
            assert not engine.paused and not engine.speech_stream and not engine.tasks
            self.listening = True
            self.identity += 1
            identity = self.identity
            blocks = wake if self.feeds == 0 else direct if self.feeds == 1 else silent
            self.feeds += 1
            async def feed():
                for block in blocks:
                    if identity != self.identity or not self.listening:
                        return
                    receive(block.copy(), False)
                    await asyncio.sleep(.02)
            asyncio.create_task(feed())
        def cancel(self):
            self.identity += 1
            self.listening = False
        def play(self, pcm, rate, cancelled, level):
            assert not self.listening, 'mic during actual synthesized playback'
            self.played += len(pcm)
            level(.1)
    audio = SilentAudio()
    engine = Engine(models, audio, emit, voice, wake_factory=lambda: detector)
    emit({'type': 'ready'})
    engine.speaker_status()
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        data = json.loads(line)
        if data['type'] == 'probe-end':
            break
        await engine.command(data)
    engine.cancel()
    await engine.wait()
    emit({'type': 'probe-result', 'played': audio.played, 'feeds': audio.feeds,
          'device': models.device, 'micClosed': not audio.listening})


if __name__ == '__main__':
    asyncio.run(main())
