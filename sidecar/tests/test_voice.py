import importlib.util
import os
from pathlib import Path
import numpy as np
import pytest


def module():
    assert (Path(__file__).parents[1] / 'voice.py').is_file(), 'Local voice runtime is not implemented'
    import voice
    return voice


def test_missing_models_fail_offline_before_any_loader(tmp_path, monkeypatch):
    voice = module()
    calls = []
    monkeypatch.setenv('HF_HUB_OFFLINE', '0')
    with pytest.raises(voice.ModelMissing, match='setup-models'):
        voice.LocalModels(tmp_path, whisper_factory=lambda *a, **kw: calls.append(kw))
    assert os.environ['HF_HUB_OFFLINE'] == '1'
    assert calls == []


def fake_models(tmp_path, voice_dir='amy', model='en_US-amy-medium', rate=22050):
    for name in ['whisper/model.bin', 'whisper/config.json', 'whisper/tokenizer.json', f'{voice_dir}/{model}.onnx']:
        file = tmp_path / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.touch()
    (tmp_path / voice_dir / f'{model}.onnx.json').write_text('{"audio": {"sample_rate": %d}}' % rate)
    return tmp_path


def test_persona_voice_uses_voices_folder_tuning_and_its_sample_rate(tmp_path):
    voice = module()
    from persona import Voice
    calls = []
    class Other:
        def synthesize(self, text, syn_config):
            calls.append(syn_config)
            yield type('Chunk', (), {'audio_float_array': np.ones(10, dtype=np.float32), 'sample_rate': 16000})()
    models = voice.LocalModels(fake_models(tmp_path, 'voices', 'en_GB-alba-medium', 16000),
                               voice=Voice('en_GB-alba-medium', 1.1, .4, .6, .9))
    loaded = []
    models.piper_factory = lambda path: loaded.append(path) or Other()
    pcm, rate = models.synthesize('Hello.')
    assert rate == 16000 and loaded[0].name == 'en_GB-alba-medium.onnx' and loaded[0].parent.name == 'voices'
    assert (calls[0].length_scale, calls[0].noise_scale, calls[0].noise_w_scale, calls[0].volume) == (1.1, .4, .6, .9)


def test_missing_persona_voice_fails_offline(tmp_path):
    voice = module()
    from persona import Voice
    with pytest.raises(voice.ModelMissing, match='setup-models'):
        voice.LocalModels(fake_models(tmp_path), voice=Voice('en_GB-alba-medium'))


def test_transcribes_vad_trimmed_memory_on_cpu_after_cuda_failure(tmp_path):
    voice = module()
    calls = []
    class Whisper:
        def transcribe(self, audio, **kw):
            calls.append(('transcribe', audio.copy(), kw))
            return [type('Segment', (), {'text': ' local transcript '})()], None
    def factory(path, **kw):
        calls.append((path, kw))
        if kw['device'] == 'cuda':
            raise RuntimeError('CUDA unavailable')
        return Whisper()
    models = voice.LocalModels(fake_models(tmp_path), whisper_factory=factory)
    models.trim = lambda audio: audio[10:20]
    assert models.transcribe(np.ones(40, dtype=np.float32)) == 'local transcript'
    assert models.device == 'cpu'
    assert calls[0][1]['local_files_only'] is True
    assert calls[1][1]['compute_type'] == 'int8'
    assert len(calls[-1][1]) == 10
    # Audio the speaker filter already trimmed is not trimmed a second time.
    assert models.transcribe(np.ones(40, dtype=np.float32), trimmed=True) == 'local transcript'
    assert len(calls[-1][1]) == 40


def test_amy_synthesis_keeps_tuning_and_pcm_local(tmp_path):
    voice = module()
    calls = []
    class Amy:
        def synthesize(self, text, syn_config):
            calls.append((text, syn_config))
            yield type('Chunk', (), {'audio_float_array': np.ones(100, dtype=np.float32), 'sample_rate': 22050})()
    models = voice.LocalModels(fake_models(tmp_path))
    models.piper_factory = lambda path: Amy()
    pcm, rate = models.synthesize('Hello locally.')
    assert rate == 22050 and len(pcm) == 100
    config = calls[0][1]
    assert (config.length_scale, config.noise_scale, config.noise_w_scale, config.volume) == (.7, .5, .8, .65)


def test_followup_onset_uses_silero_without_endpoint_duration_gate(tmp_path, monkeypatch):
    from faster_whisper import vad
    seen = []
    def spans(audio, options):
        seen.append(options)
        return [{'start': 0, 'end': len(audio)}]
    monkeypatch.setattr(vad, 'get_speech_timestamps', spans)
    models = module().LocalModels(fake_models(tmp_path))
    pcm = np.ones(800, dtype=np.float32)
    assert len(models.onset(pcm)) == len(pcm)
    assert len(models.trim(pcm)) == len(pcm)
    assert [o.min_speech_duration_ms for o in seen] == [0, 150]
    assert seen[0].threshold == seen[1].threshold
