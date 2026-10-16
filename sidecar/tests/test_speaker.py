"""Synthetic vectors only; never a household voice profile."""
from pathlib import Path
import numpy as np
import pytest


def vector(offset=0.):
    v = np.zeros(256)
    v[0], v[1] = 1, offset
    return v


def test_multisample_enrollment_requires_heldout_checks_and_persists_only_profile():
    from speaker import Enrollment, load_profile, save_profile
    path = Path(__file__).parents[2] / '.cache/m5-test/voice-profile.json'
    path.unlink(missing_ok=True)
    enrollment = Enrollment()
    for offset in [0, .04, -.03, .02, -.02]:
        assert enrollment.add(vector(offset)) is None
    profile = enrollment.add(vector(.03))
    assert profile['sample_count'] == 6 and profile['check_count'] == 2
    assert 0 < profile['threshold'] < 1
    save_profile(path, profile)
    loaded = load_profile(path)
    assert loaded == profile
    assert set(profile) == {'version', 'model_sha256', 'embedding', 'threshold', 'sample_count', 'check_count', 'positive_scores'}
    assert [p.name for p in path.parent.iterdir()] == ['voice-profile.json']
    path.unlink()


def test_metadata_is_checked_before_native_extractor_and_wrong_model_is_visible(tmp_path):
    from speaker import validate_metadata, verify_model, METADATA, SpeakerError
    assert validate_metadata(METADATA) == METADATA
    for key in METADATA:
        broken = dict(METADATA)
        broken.pop(key)
        with pytest.raises(SpeakerError, match='metadata'):
            validate_metadata(broken)
    with pytest.raises(SpeakerError, match='setup-models'):
        verify_model(tmp_path / 'missing.onnx')
    bad = tmp_path / 'broken.onnx'
    bad.write_bytes(b'malformed model')
    with pytest.raises(SpeakerError, match='SHA256'):
        verify_model(bad)


def test_filter_trims_before_embedding_and_rejects_insufficient_nonmatch_and_unenrolled(tmp_path):
    from speaker import VoiceFilter, SpeakerError
    seen = []
    class Models:
        def trim(self, pcm):
            return pcm[16000:-16000]
    def embed(pcm):
        seen.append(pcm.copy())
        return vector()
    filt = VoiceFilter(Models(), tmp_path / 'voice-profile.json', embed=embed)
    pcm = np.r_[np.zeros(16000), np.ones(32000) * .1, np.zeros(16000)].astype(np.float32)
    with pytest.raises(SpeakerError, match='Enroll'):
        filt.accept(vector())
    trimmed, embedding = filt.analyze(pcm)
    assert len(trimmed) == 32000 and np.all(seen[0] == .1)
    with pytest.raises(SpeakerError, match='short'):
        filt.analyze(np.zeros(33000, dtype=np.float32))
    from speaker import Enrollment, save_profile
    enrollment = Enrollment()
    for offset in [0, .04, -.03, .02, -.02, .03]:
        profile = enrollment.add(vector(offset))
    filt.commit(profile)
    assert filt.accept(embedding)
    assert not filt.accept(-embedding)
    assert VoiceFilter(Models(), tmp_path / 'voice-profile.json', embed=embed).accept(embedding)


def test_setup_pins_the_verified_sherpa_release_and_preserves_existing_models():
    from speaker import MODEL_SHA256
    setup = (Path(__file__).parents[2] / 'scripts/setup-models.ps1').read_text()
    assert MODEL_SHA256 in setup
    assert 'speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx' in setup
    assert 'verify_model' in setup
    assert 'Whisper already present' in setup
    assert 'Voice already present' in setup


def test_preflight_cannot_inherit_the_sidecar_lifecycle_stdin(monkeypatch, tmp_path):
    import speaker
    from types import SimpleNamespace
    import subprocess
    model = tmp_path / 'fixture.onnx'
    model.write_bytes(b'fake model')
    monkeypatch.setattr(speaker, 'MODEL_SHA256', speaker.hashlib.sha256(model.read_bytes()).hexdigest())
    def run(*args, **kwargs):
        assert kwargs['stdin'] == subprocess.DEVNULL
        return SimpleNamespace(returncode=0, stdout=speaker.json.dumps(speaker.METADATA))
    monkeypatch.setattr(speaker.subprocess, 'run', run)
    assert speaker.verify_model(model) == speaker.METADATA


def test_enrollment_cannot_collect_more_than_six_samples_after_completion():
    from speaker import Enrollment, SpeakerError
    e = Enrollment()
    for offset in [0, .04, -.03, .02, -.02, .03]:
        profile = e.add(vector(offset))
    with pytest.raises(SpeakerError, match='complete'):
        e.add(vector())
    assert len(e.samples) == 6


def test_bad_heldout_sample_is_retryable_without_changing_training():
    from speaker import Enrollment, SpeakerError
    e = Enrollment()
    for offset in [0, .04, -.03, .02]:
        assert e.add(vector(offset)) is None
    with pytest.raises(SpeakerError, match='Check did not match'):
        e.add(-vector())
    assert len(e.samples) == 4
    assert e.add(vector(.01)) is None
    assert e.add(vector(.02)) is not None


def test_inconsistent_training_and_noisy_audio_are_retryable(tmp_path):
    from speaker import Enrollment, SpeakerError, VoiceFilter
    e = Enrollment()
    e.add(vector()); e.add(vector(.01))
    with pytest.raises(SpeakerError, match='Inconsistent'):
        e.add(-vector())
    class Models:
        def trim(self, pcm):
            return pcm
    def forbidden(pcm):
        raise AssertionError('Bad-quality input must not reach extractor')
    filt = VoiceFilter(Models(), tmp_path / 'voice-profile.json', embed=forbidden)
    for pcm in [np.zeros(32000), np.ones(32000), np.full(32000, np.nan)]:
        with pytest.raises(SpeakerError, match='quiet, noisy or clipped'):
            filt.analyze(pcm)
