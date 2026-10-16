import asyncio
import json
import struct
import pytest
from engine import SPEECH_FRAME_BYTES, SPEECH_CHUNK_CHARACTERS
from server import MAX_FRAME, ProtocolError, VoiceServer, read_frame
from test_server import connect, receive
from test_engine import Audio, Models


def body(data):
    return json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def masked(data):
    payload, mask = body(data), b'abcd'
    size = len(payload)
    header = bytes([0x81, 0x80 | size]) if size < 126 else bytes([0x81, 0xfe]) + struct.pack('!H', size)
    return header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))


def maximum_payload():
    chunks = ['x' * 400] * 40
    data = {'type': 'speak', 'chunks': chunks + ['z']}
    data['chunks'][-1] += 'z' * (MAX_FRAME - len(body(data)))
    assert len(data['chunks'][-1]) <= SPEECH_CHUNK_CHARACTERS
    assert len(body(data)) == MAX_FRAME == SPEECH_FRAME_BYTES
    return data


def test_exact_16kib_speech_frame_reaches_engine_and_sink_over_authenticated_loopback(monkeypatch):
    async def no_hotkeys(*args):
        await asyncio.Future()
    monkeypatch.setattr('server.observe', no_hotkeys)
    async def run():
        data = maximum_payload()
        synthesized = []
        class Recording(Models):
            def synthesize(self, text):
                synthesized.append(text)
                return super().synthesize(text)
        audio = Audio()
        server = VoiceServer('test-token-' * 8, Recording(), lambda: audio)
        listener = await asyncio.start_server(server.handle, '127.0.0.1', 0)
        reader, writer = await connect(listener.sockets[0].getsockname()[1])
        try:
            writer.write(masked({'type': 'auth', 'token': 'test-token-' * 8})); await writer.drain()
            assert (await receive(reader))['type'] == 'ready'
            assert (await receive(reader))['type'] == 'speaker'
            writer.write(masked({'type': 'mode', 'enabled': True}) + masked(data)); await writer.drain()
            speaking = False
            while True:
                event = await asyncio.wait_for(receive(reader), 3)
                if event == {'type': 'state', 'state': 'speaking'}:
                    speaking = True
                if speaking and event == {'type': 'state', 'state': 'idle'}:
                    break
            assert synthesized == data['chunks']
            assert len(audio.played) == len(data['chunks'])
        finally:
            writer.close(); await writer.wait_closed()
            listener.close(); await listener.wait_closed()
            while server.engine is not None:
                await asyncio.sleep(.001)
    asyncio.run(asyncio.wait_for(run(), 10))


def test_one_byte_over_existing_frame_budget_is_rejected_before_decode_or_synthesis():
    async def run():
        data = maximum_payload()
        data['chunks'][-1] += 'z'
        assert len(body(data)) == MAX_FRAME + 1
        reader = asyncio.StreamReader()
        reader.feed_data(masked(data)); reader.feed_eof()
        with pytest.raises(ProtocolError):
            await read_frame(reader, None)
    asyncio.run(run())
