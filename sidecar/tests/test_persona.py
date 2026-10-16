import json
import pytest
from fillers import PHRASES
from persona import Persona, Voice, parse


def test_missing_persona_keeps_megan_defaults():
    assert parse('') == Persona('Hey Megan', Voice(), PHRASES)
    assert Voice() == Voice('en_US-amy-medium', .7, .5, .8, .65)


def test_persona_overrides_voice_wake_and_fillers():
    p = parse(json.dumps({'wakePhrase': 'Hey Nova', 'voice': {'model': 'en_GB-alba-medium', 'lengthScale': 1.0},
                          'fillers': ['One moment.']}))
    assert p.wake_phrase == 'Hey Nova' and p.fillers == ('One moment.',)
    assert p.voice == Voice('en_GB-alba-medium', 1.0, .5, .8, .65)


@pytest.mark.parametrize('raw', [{'wakePhrase': 'Nova'}, {'voice': {'model': '../evil'}},
                                 {'voice': {'lengthScale': 9}}, {'fillers': 'nope'}, {'fillers': ['x' * 81]}])
def test_invalid_persona_rejected(raw):
    with pytest.raises(ValueError):
        parse(json.dumps(raw))
