import asyncio
import base64
import json
import os
import struct
from pathlib import Path


def masked(data):
    body = json.dumps(data).encode()
    mask = b'abcd'
    return bytes([0x81, 0x80 | len(body)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(body))


async def connect(port):
    reader, writer = await asyncio.open_connection('127.0.0.1', port)
    key = base64.b64encode(os.urandom(16)).decode()
    writer.write(f'GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n\r\n'.encode())
    await writer.drain()
    response = await reader.readuntil(b'\r\n\r\n')
    assert b'101 Switching Protocols' in response
    return reader, writer


async def receive(reader):
    head = await reader.readexactly(2)
    size = head[1] & 127
    if size == 126:
        size = struct.unpack('!H', await reader.readexactly(2))[0]
    return json.loads(await reader.readexactly(size))


def test_unauthenticated_or_wrong_token_never_opens_mic():
    assert (Path(__file__).parents[1] / 'server.py').is_file(), 'Authenticated sidecar server not implemented'
    from server import VoiceServer
    from test_engine import Audio, Models
    async def run():
        audio = Audio()
        server = VoiceServer('secret-' * 8, Models(), lambda: audio)
        listener = await asyncio.start_server(server.handle, '127.0.0.1', 0)
        port = listener.sockets[0].getsockname()[1]
        for message in [{'type': 'start'}, {'type': 'auth', 'token': 'wrong'}]:
            r, w = await connect(port)
            w.write(masked(message)); await w.drain()
            assert (await r.readexactly(2))[0] == 0x88  # policy close, no ready/recording
            w.close(); await w.wait_closed()
        assert not audio.listening and server.engine is None
        r, w = await connect(port)
        w.write(masked({'type': 'auth', 'token': 'secret-' * 8})); await w.drain()
        assert (await receive(r))['type'] == 'ready'
        assert (await receive(r))['type'] == 'speaker'
        w.write(masked({'type': 'mode', 'enabled': True})); await w.drain()
        w.write(masked({'type': 'start'})); await w.drain()
        assert (await receive(r))['state'] == 'listening'
        w.close(); await w.wait_closed()
        await asyncio.sleep(.05)
        assert not audio.listening
        listener.close(); await listener.wait_closed()
    asyncio.run(run())


def test_browser_origin_and_non_control_frames_are_rejected_before_audio():
    import pytest
    from server import handshake, read_frame, ProtocolError
    class Writer:
        def write(self, data): pass
        async def drain(self): pass
    async def run():
        reader = asyncio.StreamReader()
        reader.feed_data(b'GET / HTTP/1.1\r\nOrigin: https://example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: YWJjZGVmZ2hpamtsbW5vcA==\r\n\r\n')
        with pytest.raises(ProtocolError):
            await handshake(reader, Writer())
        for payload in [b'\x81\x02{}', b'\x82\x80', b'\x01\x80', b'\x81\xfe\xff\xff']:
            reader = asyncio.StreamReader(); reader.feed_data(payload); reader.feed_eof()
            with pytest.raises(ProtocolError):
                await read_frame(reader, Writer())
    asyncio.run(run())


def test_server_no_token_and_missing_model_startup_never_bind(monkeypatch, capsys):
    import server
    from voice import ModelMissing
    monkeypatch.delenv('ORB_VOICE_TOKEN', raising=False)
    assert asyncio.run(server.main()) == 2
    assert 'Launch token required' in capsys.readouterr().out
    monkeypatch.setenv('ORB_VOICE_TOKEN', 'x' * 64)
    def missing(root):
        raise ModelMissing('missing')
    monkeypatch.setattr(server, 'LocalModels', missing)
    assert asyncio.run(server.main()) == 3
    assert 'setup-models.ps1' in capsys.readouterr().out
