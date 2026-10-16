"""Persona voice settings sent by Electron main in ORB_PERSONA (JSON, no secrets).

Main validates personas/<name>/persona.json; this re-checks the few fields the
sidecar uses. Without ORB_PERSONA the defaults are the bundled Megan persona.
"""
from dataclasses import dataclass, field
import json
import os
import re
from fillers import PHRASES

DEFAULT_WAKE_PHRASE = 'Hey Megan'
VOICE_ID = re.compile(r'^[a-z]{2,3}_[A-Z]{2}-[a-z0-9_]+-(?:x_low|low|medium|high)$')
WAKE_PHRASE = re.compile(r"^[A-Za-z]+(?:[ '-][A-Za-z]+){1,3}$")


@dataclass(frozen=True)
class Voice:
    model: str = 'en_US-amy-medium'
    length_scale: float = .7
    noise_scale: float = .5
    noise_w: float = .8
    volume: float = .65


@dataclass(frozen=True)
class Persona:
    wake_phrase: str = DEFAULT_WAKE_PHRASE
    voice: Voice = field(default_factory=Voice)
    fillers: tuple = PHRASES


def _number(raw, key, low, high, default):
    value = raw.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise ValueError(f'persona voice.{key} out of range')
    return float(value)


def parse(text):
    if not text:
        return Persona()
    raw = json.loads(text)
    phrase = raw.get('wakePhrase', DEFAULT_WAKE_PHRASE)
    if not isinstance(phrase, str) or not WAKE_PHRASE.match(phrase):
        raise ValueError('persona wakePhrase invalid')
    v = raw.get('voice') or {}
    model = v.get('model', Voice.model)
    if not isinstance(model, str) or not VOICE_ID.match(model):
        raise ValueError('persona voice.model invalid')
    voice = Voice(model, _number(v, 'lengthScale', .3, 2, Voice.length_scale),
                  _number(v, 'noiseScale', 0, 1.5, Voice.noise_scale),
                  _number(v, 'noiseW', 0, 1.5, Voice.noise_w),
                  _number(v, 'volume', .05, 1, Voice.volume))
    fillers = raw.get('fillers', list(PHRASES))
    if (not isinstance(fillers, list) or len(fillers) > 40
            or any(not isinstance(line, str) or not line.strip() or len(line) > 80 for line in fillers)):
        raise ValueError('persona fillers invalid')
    return Persona(phrase, voice, tuple(line.strip() for line in fillers))


def from_env():
    return parse(os.environ.get('ORB_PERSONA', ''))


def wake_prefix(phrase):
    """Regex for the wake phrase at the start of a transcript, tolerant of Whisper punctuation."""
    words = re.split(r"[ '-]+", phrase.strip())
    return re.compile(r'^\s*' + r"[\s,'-]*".join(re.escape(w) for w in words) + r'\b[\s,.:;!?—-]*', re.IGNORECASE)
