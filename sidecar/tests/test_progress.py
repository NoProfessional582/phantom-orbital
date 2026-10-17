import asyncio
from engine import Engine
from persona import Persona
from test_engine import Audio, Models


def engine_with_cache(progress=('Still on it.',)):
    audio = Audio()
    engine = Engine(Models(), audio, [].append, None, persona=Persona(fillers=(), progress=progress, speaker_filter=False))
    return engine, audio


def test_progress_plays_one_cached_line_without_delay():
    async def run():
        engine, audio = engine_with_cache()
        await engine.command({'type': 'voice-mode', 'mode': 'voice', 'revision': 1})
        await engine.filler_prewarm
        assert list(engine.progress_cache) == ['Still on it.']
        engine.speech_stream = {'id': 'reply', 'seq': 0, 'queue': []}  # opened, nothing said yet
        await engine.command({'type': 'progress'})
        engine.speech_stream = None
        await engine.wait()
        assert audio.played == [(100, 22050)]
    asyncio.run(run())


def test_progress_is_silent_when_voice_is_off_or_a_reply_is_streaming():
    async def run():
        engine, audio = engine_with_cache()
        await engine.command({'type': 'voice-mode', 'mode': 'voice', 'revision': 1})
        await engine.filler_prewarm
        engine.speech_stream = {'id': 'reply', 'seq': 1, 'queue': []}  # already speaking
        await engine.command({'type': 'progress'})
        engine.speech_stream = None
        await engine.command({'type': 'voice-mode', 'mode': 'off', 'revision': 2})
        await engine.command({'type': 'progress'})
        await engine.wait()
        assert audio.played == []
    asyncio.run(run())
