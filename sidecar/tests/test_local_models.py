"""Run explicitly with ORB_TEST_LOCAL_MODELS=1. Generated audio only, no mic."""
import os
import socket
from pathlib import Path
import numpy as np
import pytest


@pytest.mark.skipif(os.environ.get('ORB_TEST_LOCAL_MODELS') != '1', reason='explicit local-model integration gate')
def test_real_amy_vad_whisper_succeed_with_all_network_connections_denied(monkeypatch):
    def deny(*args, **kwargs):
        raise AssertionError('Runtime attempted a network connection')
    monkeypatch.setattr(socket.socket, 'connect', deny)
    monkeypatch.setattr(socket.socket, 'connect_ex', deny)
    monkeypatch.setattr(socket, 'create_connection', deny)
    from voice import LocalModels
    models = LocalModels(Path(__file__).parents[1] / 'models')
    pcm, rate = models.synthesize('This is a synthetic local voice test.')
    assert rate == 22050 and len(pcm) > rate
    audio = np.interp(np.arange(int(len(pcm) * 16000 / rate)) * rate / 16000,
                      np.arange(len(pcm)), pcm).astype(np.float32)
    text = models.transcribe(audio)
    assert 'synthetic local voice test' in text.lower()
    assert models.device in ('cuda', 'cpu')
    assert os.environ['HF_HUB_OFFLINE'] == '1'
