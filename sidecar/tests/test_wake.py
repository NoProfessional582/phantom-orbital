import hashlib
import os
import subprocess
import sys
import tarfile
from pathlib import Path
import numpy as np
import pytest


def test_exact_keyword_tokens_and_missing_model_fail_before_native(tmp_path):
    from wake import KEYWORD, KEYWORD_TOKENS, WakeError, verify_files
    assert KEYWORD == 'HEY_MEGAN'
    assert ''.join(KEYWORD_TOKENS).replace('▁', ' ').strip() == 'HEY MEGAN'
    with pytest.raises(WakeError, match='setup-models'):
        verify_files(tmp_path)


def test_install_rejects_traversal_and_links_without_writing(tmp_path, monkeypatch):
    import wake
    from wake import install_archive, WakeError
    for name, kind in [('../escape', tarfile.REGTYPE), ('safe', tarfile.SYMTYPE)]:
        archive = tmp_path / 'bad.tar.bz2'
        with tarfile.open(archive, 'w:bz2') as t:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = '../escape'
            t.addfile(member)
        # Reach the member validation, independently of the archive pin guard.
        monkeypatch.setattr(wake, 'ARCHIVE_BYTES', archive.stat().st_size)
        monkeypatch.setattr(wake, 'ARCHIVE_SHA256', hashlib.sha256(archive.read_bytes()).hexdigest())
        with pytest.raises(WakeError, match='Unsafe'):
            install_archive(archive, tmp_path / 'out')
        assert not (tmp_path / 'out').exists()


@pytest.mark.skipif(os.environ.get('ORB_TEST_LOCAL_MODELS') != '1', reason='explicit local-model integration gate')
def test_real_local_wake_pipeline_in_bounded_process():
    result = subprocess.run([sys.executable, '-E', '-s', str(Path(__file__).with_name('wake_probe.py'))],
                            capture_output=True, text=True, timeout=120,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, f'Native probe exit {result.returncode}\n{result.stdout}\n{result.stderr}'
    assert all(f'DELAYED {pause}ms PIPELINE' in result.stdout for pause in (600, 1500))
    assert 'PASS KWS' in result.stdout


WAKE_MODELS = Path(__file__).parents[1] / 'models' / 'wake'


@pytest.mark.skipif(not (WAKE_MODELS / 'bpe.model').is_file(), reason='needs scripts/setup-models.ps1')
def test_configured_phrase_is_spelled_with_pinned_vocabulary():
    from wake import KEYWORD, KEYWORD_TOKENS, WakeError, keyword
    assert keyword(WAKE_MODELS, 'Hey Megan') == (KEYWORD, KEYWORD_TOKENS)
    name, tokens = keyword(WAKE_MODELS, 'hey nova')
    assert name == 'HEY_NOVA' and ''.join(tokens).replace('▁', ' ').strip() == 'HEY NOVA'
    for bad in ('Megan', 'Hey Megan 2', 'one two three four five', 'Hey <Megan>'):
        with pytest.raises(WakeError):
            keyword(WAKE_MODELS, bad)


def test_wake_prefix_strips_configured_phrase_only_at_start():
    from persona import wake_prefix
    prefix = wake_prefix('Hey Nova')
    text = 'Hey, Nova. What time is it?'
    assert text[prefix.match(text).end():] == 'What time is it?'
    assert prefix.match('Hey Megan, what time is it?') is None
    assert wake_prefix("Okay O'Brien").match("okay o'brien, lights")
