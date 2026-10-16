"""Local registered-speaker profile/calibration. No audio is persisted.
Positive-only calibration is a convenience filter, not authentication and not
an estimate of impostor false acceptance. Four examples and two held-out checks.
"""
import json
import hashlib
import subprocess
import sys
from pathlib import Path
import numpy as np

MODEL_SHA256 = '5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94'
MODEL_NAME = 'wespeaker_en_voxceleb_resnet34.onnx'
METADATA = {'framework': 'wespeaker', 'sample_rate': '16000', 'output_dim': '256',
            'normalize_samples': '0', 'language': 'English'}


class SpeakerError(RuntimeError):
    pass


def validate_metadata(metadata):
    if any(metadata.get(k) != v for k, v in METADATA.items()):
        raise SpeakerError('Speaker model metadata invalid. Run scripts/setup-models.ps1.')
    return metadata


def verify_model(path):
    path = Path(path)
    if not path.is_file():
        raise SpeakerError('Speaker model missing. Run scripts/setup-models.ps1 -Download.')
    if hashlib.sha256(path.read_bytes()).hexdigest() != MODEL_SHA256:
        raise SpeakerError('Speaker model SHA256 mismatch. Run scripts/setup-models.ps1 -Download.')
    # ONNX/native parsing stays in a fresh bounded process, before sherpa is used.
    try:
        result = subprocess.run([sys.executable, '-E', '-s', str(Path(__file__).resolve()),
                                 '--metadata', str(path.resolve())],
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode != 0 or len(result.stdout) > 8192:
            raise SpeakerError(f'Speaker model preflight failed (exit {result.returncode}). Run scripts/setup-models.ps1.')
        return validate_metadata(json.loads(result.stdout))
    except (subprocess.TimeoutExpired, ValueError, OSError) as exc:
        raise SpeakerError(f'Speaker model preflight failed ({type(exc).__name__}, {getattr(exc, "winerror", None)}). Run scripts/setup-models.ps1.') from exc


def unit(embedding):
    v = np.asarray(embedding, dtype=np.float64)
    if v.shape != (256,) or not np.isfinite(v).all() or np.linalg.norm(v) < 1e-12:
        raise SpeakerError('Invalid local speaker embedding. Retry enrollment.')
    return v / np.linalg.norm(v)


class Enrollment:
    def __init__(self):
        self.samples = []

    def add(self, embedding):
        if len(self.samples) >= 6:
            raise SpeakerError('Enrollment complete. Start a new enrollment to retry.')
        v = unit(embedding)
        if len(self.samples) >= 4:
            center = unit(np.mean(self.samples[:4], axis=0))
            scores = [float(unit(np.mean([b for j, b in enumerate(self.samples[:4]) if i != j], axis=0)) @ a)
                      for i, a in enumerate(self.samples[:4])]
            allowance = max(float(np.ptp(scores)), 1e-6)
            if float(v @ center) < min(scores) - allowance:
                raise SpeakerError('Check did not match enrollment. Retry in a quiet room using only your voice.')
        candidate = self.samples + [v]
        if len(candidate) <= 4 and len(candidate) >= 3:
            distances = [1 - float(a @ b) for i, a in enumerate(candidate) for b in candidate[i + 1:]]
            if min(1 - d for d in distances) <= 0 or max(distances) > 8 * max(float(np.median(distances)), 1e-6):
                raise SpeakerError('Inconsistent enrollment. Retry all samples in a quiet room.')
        self.samples.append(v)
        if len(self.samples) < 6:
            return None
        center = unit(np.mean(self.samples[:4], axis=0))
        scores = [float(unit(np.mean([b for j, b in enumerate(self.samples[:4]) if i != j], axis=0)) @ a)
                  for i, a in enumerate(self.samples[:4])]
        scores += [float(center @ a) for a in self.samples[4:]]
        threshold = min(scores) - max(float(np.ptp(scores)), 1e-6)
        if threshold <= 0:
            raise SpeakerError('Enrollment varies too much. Retry all samples in a quiet room.')
        return {'version': 1, 'model_sha256': MODEL_SHA256, 'embedding': center.tolist(),
                'threshold': threshold, 'sample_count': 6, 'check_count': 2,
                'positive_scores': scores}


def validate_profile(profile):
    if (not isinstance(profile, dict) or profile.get('version') != 1
            or profile.get('model_sha256') != MODEL_SHA256
            or profile.get('sample_count') != 6 or profile.get('check_count') != 2):
        raise SpeakerError('Voice profile invalid or outdated. Enroll again.')
    unit(profile.get('embedding'))
    threshold = profile.get('threshold')
    scores = np.asarray(profile.get('positive_scores'), dtype=float)
    if (not isinstance(threshold, (float, int)) or not 0 < threshold <= 1
            or scores.shape != (6,) or not np.isfinite(scores).all()):
        raise SpeakerError('Voice calibration invalid. Enroll again.')
    return profile


def load_profile(path):
    path = Path(path)
    if not path.exists():
        return None
    if path.stat().st_size > 32768:
        raise SpeakerError('Voice profile invalid. Enroll again.')
    try:
        return validate_profile(json.loads(path.read_text(encoding='utf-8')))
    except (ValueError, TypeError, OSError) as exc:
        raise SpeakerError('Voice profile unreadable. Enroll again.') from exc


def save_profile(path, profile):
    validate_profile(profile)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix('.pending')
    try:
        pending.write_text(json.dumps(profile, allow_nan=False), encoding='utf-8')
        pending.replace(path)
    finally:
        pending.unlink(missing_ok=True)


class VoiceFilter:
    """Reusable PTT/future wake boundary; takes 16kHz mono PCM, never text."""
    def __init__(self, models, profile_path, embed=None):
        self.models, self.path = models, Path(profile_path)
        self.extractor = None
        self.embed_override = embed
        self.notice = ''
        try:
            self.profile = load_profile(self.path)
        except (SpeakerError, OSError):
            self.profile = None
            self.notice = 'Voice profile unreadable. Enroll again.'

    def embed(self, audio):
        if self.embed_override:
            return unit(self.embed_override(audio))
        if self.extractor is None:
            model = self.models.root / 'speaker' / MODEL_NAME
            verify_model(model)
            import sherpa_onnx
            config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(model), num_threads=1, provider='cpu')
            if not config.validate():
                raise SpeakerError('Speaker model configuration invalid. Run scripts/setup-models.ps1.')
            self.extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
        stream = self.extractor.create_stream()
        stream.accept_waveform(sample_rate=16000, waveform=audio)
        stream.input_finished()
        if not self.extractor.is_ready(stream):
            raise SpeakerError('Speech too short for speaker matching. Retry.')
        return unit(self.extractor.compute(stream))

    def analyze(self, pcm, enrolling=False):
        if len(pcm) > 16000 * (10 if enrolling else 30):
            raise SpeakerError('Use a short 2–8 second utterance. Retry.')
        audio = np.ascontiguousarray(self.models.trim(pcm), dtype=np.float32)
        if len(audio) < 24000:
            raise SpeakerError('Speech too short or background only. Hold for 2–8 seconds and retry.')
        if (not np.isfinite(audio).all() or float(np.sqrt(np.mean(audio ** 2))) < .003
                or float(np.mean(np.abs(audio) >= .99)) > .02):
            raise SpeakerError('Speech too quiet, noisy or clipped. Retry closer to the microphone.')
        return audio, self.embed(audio)

    def accept(self, embedding):
        if self.profile is None:
            raise SpeakerError('Enroll your voice first. Typed text still works.')
        return float(unit(self.profile['embedding']) @ unit(embedding)) >= self.profile['threshold']

    def commit(self, profile):
        save_profile(self.path, profile)
        self.profile = profile


if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--metadata':
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    session = ort.InferenceSession(sys.argv[2], options, providers=['CPUExecutionProvider'])
    metadata = validate_metadata(session.get_modelmeta().custom_metadata_map)
    print(json.dumps(metadata))
