"""Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) using zlib + numpy."""
import struct, zlib
import numpy as np

def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    i, idat = 8, b''
    while i < len(data):
        n, kind = struct.unpack('>I4s', data[i:i + 8])
        body = data[i + 8:i + 8 + n]
        if kind == b'IHDR':
            w, h, depth, ctype, _, _, interlace = struct.unpack('>IIBBBBB', body)
        elif kind == b'IDAT':
            idat += body
        i += 12 + n
    assert depth == 8 and interlace == 0 and ctype in (2, 6), (depth, ctype, interlace)
    ch = 4 if ctype == 6 else 3
    raw = np.frombuffer(zlib.decompress(idat), dtype=np.uint8).reshape(h, 1 + w * ch)
    out = np.zeros((h, w * ch), dtype=np.int32)
    prev = np.zeros(w * ch, dtype=np.int32)
    for y in range(h):
        f, line = raw[y, 0], raw[y, 1:].astype(np.int32)
        if f == 0: cur = line
        elif f == 2: cur = (line + prev) & 255
        else:
            cur = np.zeros_like(line)
            for x in range(w * ch):
                a = cur[x - ch] if x >= ch else 0
                b = prev[x]; c = prev[x - ch] if x >= ch else 0
                if f == 1: p = a
                elif f == 3: p = (a + b) >> 1
                else:
                    pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                    p = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                cur[x] = (line[x] + p) & 255
        out[y] = cur; prev = cur
    return out.reshape(h, w, ch).astype(np.uint8)
