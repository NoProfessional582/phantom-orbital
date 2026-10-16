import asyncio
from test_wake_engine import fixture, settle


def test_ptt_coexistence_waits_for_backend_instead_of_briefly_rearming():
    async def run():
        e, a, events = fixture()
        await e.command({'type':'mode','enabled':True})
        await e.command({'type':'activation','enabled':True})
        await settle(lambda: a.listening)
        await e.command({'type':'start'})
        assert e.state == 'listening'
        await e.command({'type':'release'})
        await e.wait()
        await asyncio.sleep(.05)
        assert any(x['type']=='transcript' for x in events)
        assert not a.listening and e.awaiting_response
        await e.command({'type':'activation','enabled':False})
        await e.wait()
    asyncio.run(run())
