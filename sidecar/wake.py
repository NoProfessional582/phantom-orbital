"""Opt-in offline keyword spotting for the persona's wake phrase.

sherpa-onnx 1.13.8 KeywordSpotter API with the model's own BPE vocabulary. Any
short English phrase works without training: sentencepiece spells it with the
pinned bpe.model, and every token must exist in the pinned tokens.txt.
"""
from collections import deque
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import numpy as np

ARCHIVE_NAME = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01'
ARCHIVE_SHA256 = 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a'
ARCHIVE_BYTES = 17626723
SUFFIX = '-epoch-12-avg-2-chunk-16-left-64'
FILES = {
    'README.md': '74e42d37d63acd2366b042151d576fcc0c4917a41de339414a37f1e79f4e80e2',
    'tokens.txt': 'fd2ded4050a55d2b1578870ba8697d02371980217806b7558bd0a5cc60f3ba53',
    'bpe.model': 'c8a2a0129c4ab8e463164c142f82d25649661b122c8cd0b7aab5c9e80b90ad24',
    'encoder' + SUFFIX + '.int8.onnx': '1e721676515bcd42a186979733981213c66c80db680e1cc582dfedf3be76e678',
    'decoder' + SUFFIX + '.onnx': 'f61ebd3eed3773a44d088d53dfae92dbb6aec4839f4dcaee2d402414741663a3',
    'joiner' + SUFFIX + '.int8.onnx': 'eae9da0c7e1e6c6a3f4cc42d167899c388f6c6701b94cb96320e4f55df79624c',
}
DEFAULT_PHRASE = 'Hey Megan'
KEYWORD = 'HEY_MEGAN'
KEYWORD_TOKENS = ('▁HE', 'Y', '▁ME', 'G', 'AN')
# Post-hit timing at 16 kHz. Speech lasting past one second (allowing for the
# .4 s VAD lookback) is a command, not the wake tail. A bare wake phrase waits
# two seconds for a command to start.
CONTINUOUS_COMMAND_SAMPLES = 16000
ONSET_FLOOR_SAMPLES = 16000 * 2


class WakeError(RuntimeError):
    pass


def verify_files(root):
    root = Path(root)
    for name, digest in FILES.items():
        path = root / name
        if (not path.is_file() or path.is_symlink() or path.stat().st_size > 15000000
                or hashlib.sha256(path.read_bytes()).hexdigest() != digest):
            raise WakeError('Wake model missing/corrupt. Run scripts/setup-models.ps1 -Download explicitly.')


def keyword(root, phrase=DEFAULT_PHRASE):
    """(name, tokens) for a wake phrase, spelled with the model's pinned BPE vocabulary."""
    import sentencepiece
    root = Path(root)
    words = phrase.replace('-', ' ').split()
    if not 2 <= len(words) <= 4 or not all(w.replace("'", '').isalpha() and w.isascii() for w in words):
        raise WakeError('Wake phrase must be 2-4 plain English words.')
    text = ' '.join(words).upper()
    tokens = sentencepiece.SentencePieceProcessor(model_file=str(root / 'bpe.model')).encode(text, out_type=str)
    table = {line.split()[0] for line in (root / 'tokens.txt').read_text(encoding='utf-8').splitlines() if line.strip()}
    if not tokens or any(token not in table for token in tokens):
        raise WakeError('Wake phrase cannot be spelled by the wake model. Choose different words.')
    return text.replace(' ', '_').replace("'", ''), tuple(tokens)


def install_archive(archive, root):
    """Never extract paths or execute contents. Copy only pinned regular files."""
    archive, root = Path(archive), Path(root)
    if root.is_symlink() or root.is_junction():
        raise WakeError('Wake destination cannot be a link.')
    if (archive.stat().st_size != ARCHIVE_BYTES
            or hashlib.sha256(archive.read_bytes()).hexdigest() != ARCHIVE_SHA256):
        raise WakeError('Wake archive SHA256/size mismatch; not installed.')
    with tarfile.open(archive, 'r:bz2') as bundle:
        members = bundle.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            if (path.is_absolute() or '..' in path.parts or '\\' in member.name
                    or not (member.isfile() or member.isdir())
                    or not path.parts or path.parts[0] != ARCHIVE_NAME):
                raise WakeError('Unsafe wake archive member; not installed.')
        data = {}
        for name, digest in FILES.items():
            candidates = [m for m in members if m.name == ARCHIVE_NAME + '/' + name]
            if len(candidates) != 1 or not candidates[0].isfile() or candidates[0].size > 15000000:
                raise WakeError('Wake archive required file invalid.')
            content = bundle.extractfile(candidates[0]).read()
            if hashlib.sha256(content).hexdigest() != digest:
                raise WakeError('Wake archive file hash mismatch.')
            data[name] = content
    root.mkdir(parents=True, exist_ok=True)
    for name, content in data.items():
        target = root / name
        if target.is_symlink():
            raise WakeError('Wake destination cannot be a symlink.')
        pending = target.with_suffix(target.suffix + '.pending')
        if pending.is_symlink():
            raise WakeError('Wake pending destination cannot be a symlink.')
        pending.write_bytes(content)
        pending.replace(target)
    verify_files(root)


def metadata(root):
    verify_files(root)
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    result = {}
    for name in FILES:
        if name.endswith('.onnx'):
            session = ort.InferenceSession(str(Path(root) / name), options, providers=['CPUExecutionProvider'])
            result[name.split('-')[0]] = session.get_modelmeta().custom_metadata_map
    if (result['encoder'].get('model_type') != 'zipformer2'
            or result['encoder'].get('decode_chunk_len') != '32'
            or result['decoder'].get('context_size') != '2'
            or result['decoder'].get('vocab_size') != '500'
            or result['joiner'].get('joiner_dim') != '320'):
        raise WakeError('Wake model metadata invalid. Run scripts/setup-models.ps1.')
    return result


class WakeDetector:
    def __init__(self, root, phrase=DEFAULT_PHRASE):
        root = Path(root)
        verify_files(root)  # hashes before any native parsing
        self.keyword, tokens = keyword(root, phrase)
        keywords_file = root / 'keyword.txt'
        if keywords_file.is_symlink():
            raise WakeError('Wake keyword file cannot be a symlink.')
        keywords_file.write_text(' '.join(tokens) + ' @' + self.keyword + '\n', encoding='utf-8')
        try:
            check = subprocess.run([sys.executable, '-E', '-s', str(Path(__file__).resolve()),
                                    '--metadata', str(root.resolve())], capture_output=True,
                                   stdin=subprocess.DEVNULL, timeout=30,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if check.returncode != 0:
                raise WakeError(f'Wake model preflight failed (exit {check.returncode}). Run scripts/setup-models.ps1.')
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise WakeError('Wake model preflight failed. Run scripts/setup-models.ps1.') from exc
        import sherpa_onnx
        self.kws = sherpa_onnx.KeywordSpotter(
            tokens=str(root / 'tokens.txt'), encoder=str(root / ('encoder' + SUFFIX + '.int8.onnx')),
            decoder=str(root / ('decoder' + SUFFIX + '.onnx')),
            joiner=str(root / ('joiner' + SUFFIX + '.int8.onnx')),
            keywords_file=str(keywords_file), num_threads=1, provider='cpu')
        self.reset()

    def reset(self):
        self.stream = self.kws.create_stream()
        self.samples = 0
        self.tail = deque(maxlen=60)

    def feed(self, pcm):
        # Renew long-lived native feature state with overlapping 3s pre-roll.
        if self.samples >= 16000 * 30:
            tail = list(self.tail)
            self.reset()
            for block in tail:
                self.stream.accept_waveform(16000, block)
                self.samples += len(block)
        self.tail.append(pcm.copy())
        self.stream.accept_waveform(16000, pcm)
        self.samples += len(pcm)
        while self.kws.is_ready(self.stream):
            self.kws.decode_stream(self.stream)
            result = self.kws.get_result(self.stream)  # read exactly once: consumes result
            if result:
                self.kws.reset_stream(self.stream)
                return result == self.keyword
        return False


class FollowupCapture:
    """Five seconds for onset, then the ordinary VAD endpoint; memory only."""
    def __init__(self, trim, onset=None):
        self.trim = trim
        self.onset = onset or trim
        self.frames = []
        self.started = False
        self.elapsed = self.last_speech = 0

    def feed(self, pcm):
        if len(pcm) != 800 or not np.isfinite(pcm).all():
            raise WakeError('Follow-up capture interrupted.')
        self.frames.append(pcm.copy())
        self.elapsed += len(pcm)
        # Check every block so onset in the final 50ms is not cut off.
        detect = self.trim if self.started else self.onset
        if len(detect(np.concatenate(self.frames[-8:]))):
            self.started = True
            self.last_speech = self.elapsed
        if not self.started and self.elapsed >= 80000:
            self.frames.clear()
            return np.empty(0, dtype=np.float32)
        if self.elapsed >= 320000 or (self.started and self.elapsed - self.last_speech >= 19200):
            result = np.concatenate(self.frames)
            self.frames.clear()
            return result
        return None


class WakeCapture:
    """800-sample blocks; bounded phrase+command; VAD only after a wake hit."""
    def __init__(self, detector, trim):
        self.detector, self.trim = detector, trim
        self.ring = deque(maxlen=60)  # three seconds, memory only
        self.frames = None
        self.elapsed = self.last_speech = 0
        self.onset = 'initial'

    def feed(self, pcm):
        if len(pcm) != 800 or not np.isfinite(pcm).all():
            raise WakeError('Wake capture interrupted. Enable Voice Activation again.')
        if self.frames is None:
            self.ring.append(pcm.copy())
            if not self.detector.feed(pcm):
                return None
            self.frames = list(self.ring)
            self.ring.clear()
            self.elapsed = self.last_speech = 0
            self.onset = 'initial'
            return None
        self.frames.append(pcm.copy())
        self.elapsed += len(pcm)
        if self.elapsed % 3200 == 0:
            recent = np.concatenate(self.frames[-8:])
            if len(self.trim(recent)):
                self.last_speech = self.elapsed
                if self.onset == 'pause':
                    self.onset = 'command'
            elif self.onset == 'initial':
                # Speech that ran well past the wake hit was a continuous
                # "Hey Megan, <command>": it is over, so endpoint normally.
                # A short run is only the wake tail; wait for the command.
                self.onset = 'command' if self.last_speech >= CONTINUOUS_COMMAND_SAMPLES else 'pause'
        # After a bare "Hey Megan", give up waiting for a command at the floor.
        endpoint_ready = self.onset == 'command' or self.elapsed >= ONSET_FLOOR_SAMPLES
        if self.elapsed >= 16000 * 20 or (endpoint_ready and self.elapsed - self.last_speech >= 19200):
            result = np.concatenate(self.frames)
            self.frames = []
            return result
        return None


if __name__ == '__main__':
    if sys.argv[1] == '--verify':
        try:
            verify_files(sys.argv[2])
        except (WakeError, OSError, ValueError):
            print('Wake files need explicit setup.')
            raise SystemExit(1)
    elif sys.argv[1] == '--metadata':
        print(json.dumps(metadata(sys.argv[2])))
    elif sys.argv[1] == '--keyword':
        # Preview how a phrase is spelled: wake.py --keyword <models/wake> "Hey Nova"
        try:
            name, tokens = keyword(sys.argv[2], sys.argv[3])
        except (WakeError, OSError) as exc:
            print(exc)
            raise SystemExit(1)
        sys.stdout.reconfigure(encoding='utf-8')
        print(name, ' '.join(tokens))
    elif sys.argv[1] == '--install':
        install_archive(sys.argv[2], sys.argv[3])
        print('Pinned wake files installed; no upstream audio/scripts extracted.')
