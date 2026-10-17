"""Persona voice settings sent by Electron main in ORB_PERSONA (JSON, no secrets).

Main validates personas/<name>/persona.json; this re-checks the few fields the
sidecar uses. Without ORB_PERSONA the defaults are the bundled Megan persona.
"""
from dataclasses import dataclass, field
import json
import os
import re
from fillers import PHRASES, PROGRESS

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
    progress: tuple = PROGRESS
    # Main always sends the configured value; the bare default keeps the filter on.
    speaker_filter: bool = True


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
    fillers, progress = raw.get('fillers', list(PHRASES)), raw.get('progress', list(PROGRESS))
    for lines in (fillers, progress):
        if (not isinstance(lines, list) or len(lines) > 40
                or any(not isinstance(line, str) or not line.strip() or len(line) > 80 for line in lines)):
            raise ValueError('persona fillers/progress invalid')
    speaker_filter = raw.get('speakerFilter', True)
    if not isinstance(speaker_filter, bool):
        raise ValueError('persona speakerFilter invalid')
    return Persona(phrase, voice, tuple(line.strip() for line in fillers),
                   tuple(line.strip() for line in progress), speaker_filter)


def from_env():
    return parse(os.environ.get('ORB_PERSONA', ''))


# The keyword spotter has already heard the phrase; this only finds where it
# sits in Whisper's text. The 3 s pre-roll can put earlier words in front of it.
WAKE_SEARCH_WORDS = 15


def _sound(word):
    """Rough spelling key so Whisper variants agree: Meghan/Megan, Phil/Fil."""
    word = word.lower().replace('ph', 'f')
    word = re.sub(r'(?<=[^aeiou])h', '', word)
    return re.sub(r'(.)\1+', r'\1', word)


def _close(heard, wanted):
    a, b = _sound(heard), _sound(wanted)
    if a == b:
        return True
    # One edit on longer words (Meagan, Megyn), keeping the first letter (not "began").
    if min(len(a), len(b)) < 4 or a[0] != b[0] or abs(len(a) - len(b)) > 1:
        return False
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, y in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (x != y))
    return row[-1] <= 1


def strip_wake(phrase, text):
    """The command after the wake phrase, or '' when the phrase isn't found near the start.

    Tries the whole phrase first, then the last word alone ("Hi Megan" for "Hey Megan").
    """
    wanted = re.findall(r'[A-Za-z]+', phrase)
    words = list(re.finditer(r'[A-Za-z]+', text))[:WAKE_SEARCH_WORDS]
    for target in (wanted, wanted[-1:]):
        for start in range(len(words) - len(target) + 1):
            if all(_close(words[start + k].group(), w) for k, w in enumerate(target)):
                rest = text[words[start + len(target) - 1].end():]
                return re.sub(r'^[\s,.:;!?—-]+', '', rest).strip()
    return ''
