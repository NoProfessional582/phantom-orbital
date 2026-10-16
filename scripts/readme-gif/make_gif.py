"""Build a looping GIF from captured state frames: composite, crossfade, quantize, LZW."""
import json, struct, sys
from pathlib import Path
import numpy as np
from png import read_png

ROOT = Path(sys.argv[1]); OUT = Path(sys.argv[2])
SIZE = int(sys.argv[3]) if len(sys.argv) > 3 else 320
FPS, SECONDS, FADE = 12, 2.5, 6          # frames per second, seconds per state, crossfade frames
BG = np.array([13, 17, 23], np.float32)   # GitHub dark background
STATES = ['idle', 'listening', 'thinking', 'speaking']

def load(path):
    a = read_png(path).astype(np.float32)
    rgb = a[..., :3] * (a[..., 3:] / 255) + BG * (1 - a[..., 3:] / 255)
    h = rgb.shape[0]                       # area-ish resize via bilinear sampling
    idx = (np.arange(SIZE) + .5) * h / SIZE - .5
    i0 = np.clip(np.floor(idx).astype(int), 0, h - 1); i1 = np.clip(i0 + 1, 0, h - 1); f = (idx - i0)[:, None]
    rows = rgb[i0] * (1 - f[..., None]) + rgb[i1] * f[..., None]
    cols = rows[:, i0] * (1 - f[None, :, :]) + rows[:, i1] * f[None, :, :]
    return cols

segments = []
for state in STATES:
    d = ROOT / state
    times = json.loads((d / 'times.json').read_text())
    want = np.arange(int(FPS * SECONDS)) * 1000 / FPS
    picks = [int(np.argmin(np.abs(np.array(times) - t))) for t in want]
    segments.append([load(d / f'{p:04d}.png') for p in picks])

frames = []
for k, seg in enumerate(segments):          # each segment crossfades into the next (and last into first)
    nxt = segments[(k + 1) % len(segments)]
    body = seg[FADE:] if k else seg[FADE:]
    frames += body[:-FADE]
    for j in range(FADE):
        t = (j + 1) / (FADE + 1)
        frames.append(body[len(body) - FADE + j] * (1 - t) + nxt[j] * t)

# Global palette: k-means on sampled pixels, 255 colours + 1 transparent index.
rng = np.random.default_rng(0)
sample = np.concatenate([f.reshape(-1, 3)[rng.integers(0, SIZE * SIZE, 4000)] for f in frames])
pal = sample[rng.choice(len(sample), 255, replace=False)]
pal[0] = BG
for _ in range(12):
    d = ((sample[:, None, :] - pal[None]) ** 2).sum(-1); lab = d.argmin(1)
    for c in range(255):
        m = sample[lab == c]
        if len(m): pal[c] = m.mean(0)
pal = np.clip(pal.round(), 0, 255).astype(np.uint8)
grid = np.stack(np.meshgrid(*[np.arange(4, 256, 8)] * 3, indexing='ij'), -1).reshape(-1, 3).astype(np.float32)
lut = ((grid[:, None, :] - pal[None].astype(np.float32)) ** 2).sum(-1).argmin(1).astype(np.uint8)
def quantize(f):
    q = np.clip(f, 0, 255).astype(np.int32) >> 3
    return lut[(q[..., 0] << 10) | (q[..., 1] << 5) | q[..., 2]]
TRANSPARENT = 255

def lzw(indices, min_code=8):
    clear, end = 1 << min_code, (1 << min_code) + 1
    out, bits, nbits, size = bytearray(), 0, 0, min_code + 1
    def emit(code):
        nonlocal bits, nbits
        bits |= code << nbits; nbits += size
        while nbits >= 8: out.append(bits & 255); bits >>= 8; nbits -= 8
    table = {bytes([i]): i for i in range(clear)}; nxt = end + 1
    emit(clear); w = b''
    for b in indices.tobytes():
        wc = w + bytes([b])
        if wc in table: w = wc; continue
        emit(table[w])
        if nxt < 4096:
            table[wc] = nxt; nxt += 1
            if nxt > (1 << size) and size < 12: size += 1
        else:
            emit(clear); table = {bytes([i]): i for i in range(clear)}; nxt = end + 1; size = min_code + 1
        w = bytes([b])
    if w: emit(table[w])
    emit(end)
    if nbits: out.append(bits & 255)
    return bytes(out)

gif = bytearray(b'GIF89a' + struct.pack('<HHBBB', SIZE, SIZE, 0xF7, 0, 0))
gif += bytes(np.concatenate([pal, np.zeros((1, 3), np.uint8)]).reshape(-1))
gif += b'\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00'   # loop forever
prev = None; delay = round(100 / FPS)
for f in frames:
    idx = quantize(f)
    shown = idx.copy()
    if prev is not None: shown[idx == prev] = TRANSPARENT
    prev = idx
    gif += b'\x21\xF9\x04' + struct.pack('<BHBB', 0x05, delay, TRANSPARENT, 0)
    gif += b'\x2C' + struct.pack('<HHHHB', 0, 0, SIZE, SIZE, 0) + b'\x08'
    data = lzw(shown)
    for i in range(0, len(data), 255): gif += bytes([len(data[i:i + 255])]) + data[i:i + 255]
    gif += b'\x00'
gif += b'\x3B'
OUT.write_bytes(gif)
print(len(frames), 'frames', round(len(gif) / 1e6, 2), 'MB')
