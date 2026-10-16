"""Explicit developer fixture: Piper-generated input instead of any mic capture.

Only --mock-hermes --voice-smoke enables this in Electron. Real local Whisper,
Amy synthesis and output playback are exercised. No audio leaves the PC.
"""
import numpy as np
from audio_io import LocalAudio


class SyntheticAudio(LocalAudio):
    def __init__(self, models):
        super().__init__()
        phrases = ['Remember the word amber orbit.',
                   'The amber light shines across the quiet garden.',
                   'Please place the amber notebook beside the window.',
                   'An amber sunrise fills the room this morning.',
                   'I will read another sentence about an amber planet.',
                   'Keep the amber lantern on the wooden table.']
        self.fixtures = []
        for text in phrases:
            pcm, rate = models.synthesize(text)
            self.fixtures.append(np.interp(np.arange(int(len(pcm) * 16000 / rate)) * rate / 16000,
                                          np.arange(len(pcm)), pcm).astype(np.float32))
        self.index = 0

    def start(self, level):
        self.cancel()
        level(.25)

    def finish(self):
        pcm = self.fixtures[self.index % len(self.fixtures)].copy()
        self.index += 1
        return pcm
