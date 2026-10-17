"""Local-only models. No Hermes audio wrappers or runtime downloads."""
import json
import os
from pathlib import Path


def offline():
    os.environ.update(HF_HUB_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1')


class ModelMissing(RuntimeError):
    pass


def voice_path(root, model):
    """Piper voices live in models/voices/; Amy may still be in the original models/amy/."""
    for folder in ('voices', 'amy'):
        path = Path(root) / folder / (model + '.onnx')
        if path.is_file() and path.with_suffix('.onnx.json').is_file():
            return path
    return Path(root) / 'voices' / (model + '.onnx')


class LocalModels:
    def __init__(self, root, whisper_factory=None, voice=None):
        offline()
        from persona import Voice
        self.root = Path(root)
        self.voice = voice or Voice()
        self.voice_file = voice_path(self.root, self.voice.model)
        required = [self.root / name for name in ('whisper/model.bin', 'whisper/config.json', 'whisper/tokenizer.json')]
        required += [self.voice_file, self.voice_file.with_suffix('.onnx.json')]
        if any(not path.is_file() for path in required):
            raise ModelMissing('Local models missing. Run scripts/setup-models.ps1 explicitly.')
        try:
            self.sample_rate = int(json.loads(self.voice_file.with_suffix('.onnx.json').read_text(encoding='utf-8'))['audio']['sample_rate'])
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ModelMissing('Piper voice config invalid. Run scripts/setup-models.ps1 explicitly.') from exc
        self.whisper_factory = whisper_factory
        self.whisper = None
        self.device = 'unloaded'
        self.piper = None
        self.piper_factory = None

    def synthesize(self, text):
        import numpy as np
        from piper import PiperVoice, SynthesisConfig
        if self.piper is None:
            self.piper = (self.piper_factory or PiperVoice.load)(self.voice_file)
        v = self.voice
        chunks = list(self.piper.synthesize(text, syn_config=SynthesisConfig(
            length_scale=v.length_scale, noise_scale=v.noise_scale, noise_w_scale=v.noise_w, volume=v.volume)))
        if any(chunk.sample_rate != self.sample_rate for chunk in chunks):
            raise RuntimeError('Piper voice sample rate changed')
        return (np.concatenate([chunk.audio_float_array for chunk in chunks])
                if chunks else np.empty(0, dtype=np.float32)), self.sample_rate

    def onset(self, audio):
        # Onset is not an accepted utterance. The unchanged ordinary trim and
        # speaker minimum still gate every eventual transcript.
        return self.trim(audio, minimum=0)

    def trim(self, audio, minimum=150):
        from faster_whisper.vad import get_speech_timestamps, VadOptions
        import numpy as np
        spans = get_speech_timestamps(audio, VadOptions(min_speech_duration_ms=minimum,
                                     min_silence_duration_ms=300, speech_pad_ms=100))
        return np.concatenate([audio[s['start']:s['end']] for s in spans]) if spans else np.empty(0, dtype=np.float32)

    def transcribe(self, audio, trimmed=False):
        """Local Whisper text. Pass trimmed=True when the audio is already VAD-trimmed."""
        trimmed = audio if trimmed else self.trim(audio)
        if not len(trimmed):
            return ''
        if self.whisper is None:
            from faster_whisper import WhisperModel
            factory = self.whisper_factory or WhisperModel
            try:
                self.whisper = factory(str(self.root / 'whisper'), device='cuda',
                                       compute_type='float16', local_files_only=True)
                self.device = 'cuda'
            except Exception:
                self.whisper = factory(str(self.root / 'whisper'), device='cpu',
                                       compute_type='int8', local_files_only=True)
                self.device = 'cpu'
        try:
            segments, _ = self.whisper.transcribe(trimmed, language='en', beam_size=1,
                                                condition_on_previous_text=False)
            return ' '.join(s.text.strip() for s in segments).strip()
        except Exception:
            if self.device != 'cuda':
                raise
            from faster_whisper import WhisperModel
            factory = self.whisper_factory or WhisperModel
            self.whisper = factory(str(self.root / 'whisper'), device='cpu',
                                   compute_type='int8', local_files_only=True)
            self.device = 'cpu'
            segments, _ = self.whisper.transcribe(trimmed, language='en', beam_size=1,
                                                condition_on_previous_text=False)
            return ' '.join(s.text.strip() for s in segments).strip()
