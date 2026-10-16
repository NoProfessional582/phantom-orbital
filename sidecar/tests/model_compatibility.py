"""Explicit synthetic native diagnostic; no mic, playback or retained audio.
Run with project Python from sidecar; parent captures native exit codes.
"""
import json
import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1]))
ROOT = Path(__file__).parents[1] / 'models'


def extractor():
    import sherpa_onnx
    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(ROOT / 'speaker/wespeaker_en_voxceleb_resnet34.onnx'),
        num_threads=1, provider='cpu')
    assert config.validate()
    return sherpa_onnx.SpeakerEmbeddingExtractor(config)


def main(order):
    if order not in ('speaker-first', 'amy-first'):
        raise ValueError('Expected amy-first or speaker-first')
    from voice import LocalModels
    models = LocalModels(ROOT)
    if order == 'speaker-first':
        speaker = extractor()
        print('speaker loaded', flush=True)
    pcm, rate = models.synthesize('The amber orbit is a useful local synthetic voice check.')
    audio = np.interp(np.arange(int(len(pcm) * 16000 / rate)) * rate / 16000,
                      np.arange(len(pcm)), pcm).astype(np.float32)
    trimmed = models.trim(audio)
    assert len(trimmed) > 16000
    print('Amy synthesis and Silero VAD inferred', flush=True)
    if order == 'amy-first':
        speaker = extractor()
        print('speaker loaded', flush=True)
    stream = speaker.create_stream()
    stream.accept_waveform(sample_rate=16000, waveform=trimmed)
    stream.input_finished()
    assert speaker.is_ready(stream)
    embedding = np.asarray(speaker.compute(stream))
    assert embedding.shape == (256,) and np.isfinite(embedding).all()
    print('speaker inferred', flush=True)
    text = models.transcribe(audio)
    assert text
    print(json.dumps({'order': order, 'embedding_dim': len(embedding),
                      'vad_samples': len(trimmed), 'device': models.device,
                      'transcript': text}), flush=True)


if __name__ == '__main__':
    main(sys.argv[1])
