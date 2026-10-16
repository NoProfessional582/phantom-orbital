"""Narrow RFC6455 control transport using only Python stdlib.

Loopback only; reject browser origins, require masked unfragmented JSON <=16KiB,
then launch-token auth within 3s. No binary/audio frames or arbitrary RPC.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import struct
import sys
from pathlib import Path
from contextlib import suppress

from persona import from_env as persona_from_env
from voice import LocalModels, offline
from engine import Engine, SPEECH_FRAME_BYTES
from audio_io import LocalAudio
from hotkey import observe
from speaker import VoiceFilter

MAX_FRAME = SPEECH_FRAME_BYTES


class ProtocolError(Exception):
    pass


def enqueue_event(queue, writer, data):
    # Meter updates may be coalesced. Control/credit events must never vanish:
    # reserve half the existing queue, and fail the connection if it is exhausted.
    if data.get('type') == 'level' and queue.qsize() >= 128:
        return
    if queue.full():
        writer.close()
        return
    queue.put_nowait(data)


def frame(payload, opcode=1):
    size = len(payload)
    return (bytes([0x80 | opcode, size]) if size < 126
            else bytes([0x80 | opcode, 126]) + struct.pack('!H', size)) + payload


async def read_frame(reader, writer):
    while True:
        a, b = await reader.readexactly(2)
        opcode = a & 15
        if a & 0x70 or not a & 0x80 or not b & 0x80 or opcode not in (1, 8, 9, 10):
            raise ProtocolError()
        size = b & 127
        if size == 126:
            size = struct.unpack('!H', await reader.readexactly(2))[0]
        elif size == 127:
            size = struct.unpack('!Q', await reader.readexactly(8))[0]
        if size > MAX_FRAME or (opcode >= 8 and size > 125):
            raise ProtocolError()
        mask = await reader.readexactly(4)
        payload = await reader.readexactly(size)
        payload = bytes(value ^ mask[i % 4] for i, value in enumerate(payload))
        if opcode == 8:
            raise EOFError()
        if opcode == 9:
            writer.write(frame(payload, 10)); await writer.drain()
            continue
        if opcode == 10:
            continue
        data = json.loads(payload.decode('utf-8'))
        if not isinstance(data, dict):
            raise ProtocolError()
        return data


async def handshake(reader, writer):
    request = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 3)
    if len(request) > 8192:
        raise ProtocolError()
    lines = request.decode('ascii').split('\r\n')
    if lines[0] != 'GET / HTTP/1.1':
        raise ProtocolError()
    headers = {}
    for line in lines[1:]:
        if line:
            name, value = line.split(':', 1)
            name = name.lower().strip()
            if name in headers:
                raise ProtocolError()
            headers[name] = value.strip()
    key = headers.get('sec-websocket-key', '')
    if ('origin' in headers or headers.get('sec-websocket-version') != '13'
            or headers.get('upgrade', '').lower() != 'websocket'
            or 'upgrade' not in headers.get('connection', '').lower().split(', ')
            or len(base64.b64decode(key, validate=True)) != 16):
        raise ProtocolError()
    accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
    writer.write(f'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n'.encode())
    await writer.drain()


class VoiceServer:
    def __init__(self, token, models, audio_factory=LocalAudio, speaker=None, persona=None):
        self.token, self.models, self.audio_factory = token, models, audio_factory
        self.persona = persona
        self.speaker = speaker
        self.engine = None
        self.hotkey = False
        self.approval_hotkey = False
        self.approval_card = None

    async def handle(self, reader, writer):
        engine = None
        sender = observer = None
        try:
            if writer.get_extra_info('peername')[0] != '127.0.0.1':
                raise ProtocolError()
            await handshake(reader, writer)
            auth = await asyncio.wait_for(read_frame(reader, writer), 3)
            if (auth.get('type') != 'auth' or not isinstance(auth.get('token'), str)
                    or not hmac.compare_digest(auth['token'], self.token) or self.engine is not None):
                raise ProtocolError()
            loop = asyncio.get_running_loop()
            queue = asyncio.Queue(maxsize=256)
            def emit(data):
                loop.call_soon_threadsafe(enqueue_event, queue, writer, data)
            engine = Engine(self.models, self.audio_factory(), emit, self.speaker, persona=self.persona)
            self.engine = engine
            async def send():
                while True:
                    writer.write(frame(json.dumps(await queue.get(), ensure_ascii=True).encode()))
                    await writer.drain()
            sender = asyncio.create_task(send())
            observer = asyncio.create_task(observe(engine, lambda: self.hotkey, lambda: self.approval_hotkey, emit, lambda: self.approval_card))
            emit({'type': 'ready'})
            engine.speaker_status()
            while True:
                data = await read_frame(reader, writer)
                if data.get('type') == 'hotkey':
                    self.hotkey = data.get('enabled') is True
                elif data.get('type') == 'approval-hotkey':
                    self.approval_hotkey = data.get('enabled') is True
                    card = data.get('card')
                    self.approval_card = card if isinstance(card, str) and 0 < len(card) <= 128 else None
                else:
                    try:
                        await engine.command(data)
                    except Exception:
                        engine.cancel()
                        emit({'type': 'error', 'message': 'Local audio device unavailable. No cloud fallback.'})
        except (Exception, asyncio.CancelledError):
            # No payloads, transcripts, keys or audio logged even on protocol/device errors.
            with suppress(Exception):
                writer.write(frame(struct.pack('!H', 1008), 8))
                await writer.drain()
        finally:
            for task in (sender, observer):
                if task:
                    task.cancel()
                    with suppress(asyncio.CancelledError, Exception):
                        await task
            if engine:
                engine.enabled = False
                engine.cancel()
                await engine.wait()
                self.engine = None
            writer.close()
            with suppress(Exception):
                await writer.wait_closed()


async def main():
    offline()
    logging.disable(logging.CRITICAL)
    token = os.environ.pop('ORB_VOICE_TOKEN', '')
    if len(token) < 32:
        print(json.dumps({'error': 'Launch token required'}), flush=True)
        return 2
    try:
        persona = persona_from_env()
    except (ValueError, TypeError):
        print(json.dumps({'error': 'Persona settings invalid. Check personas/<name>/persona.json.'}), flush=True)
        return 5
    try:
        models = LocalModels(Path(__file__).parent / 'models', voice=persona.voice)
    except Exception:
        print(json.dumps({'error': 'Local models missing. Run scripts/setup-models.ps1 explicitly.'}), flush=True)
        return 3
    audio_factory = LocalAudio
    if '--synthetic-smoke' in sys.argv:
        from synthetic_fixture import SyntheticAudio
        # Explicit test-only input replaces the mic. Models/output remain real.
        synthetic = SyntheticAudio(models)
        audio_factory = lambda: synthetic
    profile_path = os.environ.pop('ORB_VOICE_PROFILE', '')
    if '--synthetic-smoke' in sys.argv:
        profile_path = str(Path(__file__).parent.parent / '.cache/synthetic-voice/voice-profile.json')
    if not profile_path or not Path(profile_path).is_absolute():
        print(json.dumps({'error': 'Application-owned voice profile path required'}), flush=True)
        return 4
    voice = VoiceServer(token, models, audio_factory, VoiceFilter(models, profile_path), persona)
    listener = await asyncio.start_server(voice.handle, '127.0.0.1', 0, limit=16384)
    print(json.dumps({'port': listener.sockets[0].getsockname()[1]}), flush=True)
    # Main owns stdin. Parent exit/pipe EOF closes the listener and releases audio.
    try:
        await asyncio.to_thread(sys.stdin.buffer.read, 1)
    finally:
        listener.close()
        await listener.wait_closed()
        if voice.engine:
            voice.engine.enabled = False
            voice.engine.cancel()
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
