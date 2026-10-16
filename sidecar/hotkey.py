"""Observe the real Windows chord using stdlib ctypes, not key-repeat timing.

Electron reserves Ctrl+Shift+Space; this process reads the high (down) bit of
GetAsyncKeyState every 10ms. No key injection, OS registration changes or hook
package. Losing a chord modifier counts as release. Disabled until Voice mode.
"""
import asyncio
import ctypes
import sys


class HoldObserver:
    def __init__(self):
        self.held = False
        self.armed = False

    def update(self, enabled, down):
        if not enabled:
            was_held = self.held
            self.held = False
            self.armed = False
            return 'cancel' if was_held else None
        if not down:
            was_held = self.held
            self.held = False
            self.armed = True
            return 'release' if was_held else None
        if self.armed and not self.held:
            self.held = True
            return 'start'
        return None


class ApprovalObserver:
    def __init__(self):
        self.card = None
        self.edge = HoldObserver()

    def update(self, card, registered, down):
        if card != self.card:
            self.card = card
            self.edge = HoldObserver()
        if self.edge.update(registered and isinstance(card, str) and bool(card), down) == 'start':
            return card
        return None


async def observe(engine, allowed, approval_allowed=lambda: False, emit=lambda data: None, approval_id=lambda: None):
    if sys.platform != 'win32':
        return  # accessible local Hold button remains usable on other platforms
    get_state = ctypes.WinDLL('user32', use_last_error=True).GetAsyncKeyState
    get_state.argtypes = [ctypes.c_int]
    get_state.restype = ctypes.c_short
    observer = HoldObserver()
    approval_observer = ApprovalObserver()
    def down(key):
        return bool(get_state(key) & 0x8000)
    while True:
        chord = down(0x11) and down(0x10) and down(0x20) and not down(0x12) and not down(0x5B) and not down(0x5C)
        action = observer.update(allowed() and engine.enabled and not engine.muted and not engine.paused, chord)
        if action:
            await engine.command({'type': action})
        # Independent physical gesture; never microphone/text consent. One
        # rising edge per fully released chord, including across restart.
        approval_chord = down(0x11) and down(0x12) and down(0x59) and not down(0x10) and not down(0x5B) and not down(0x5C)
        card = approval_observer.update(approval_id(), approval_allowed(), approval_chord)
        if card:
            emit({'type': 'approval-hotkey', 'id': card})
        await asyncio.sleep(.01)
