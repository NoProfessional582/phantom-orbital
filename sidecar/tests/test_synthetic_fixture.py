from pathlib import Path
import numpy as np


def test_explicit_synthetic_fixture_never_opens_microphone():
    assert (Path(__file__).parents[1] / 'synthetic_fixture.py').is_file(), 'Synthetic native PTT fixture not implemented'
    from synthetic_fixture import SyntheticAudio
    class Models:
        def synthesize(self, text):
            assert 'amber' in text
            return np.ones(22050, dtype=np.float32), 22050
    audio = SyntheticAudio(Models())
    audio.start(lambda level: None)
    assert audio.stream is None
    assert len(audio.finish()) == 16000
    audio.cancel()
    assert audio.stream is None


def test_synthetic_enrollment_has_distinct_short_utterances_without_mic():
    from synthetic_fixture import SyntheticAudio
    texts = []
    class Models:
        def synthesize(self, text):
            texts.append(text)
            return np.ones(22050, dtype=np.float32), 22050
    audio = SyntheticAudio(Models())
    for _ in range(6):
        audio.start(lambda level: None)
        assert audio.stream is None
        audio.finish()
    assert len(set(texts)) >= 6
