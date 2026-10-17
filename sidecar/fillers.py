"""Short local Amy lines that fill the silence while Hermes is thinking.

Edit freely: keep them short (about a second at Amy's rate) and free of the
user's name. They are synthesized locally and cached in memory only.
"""
PHRASES = (
    'One moment. Genius takes a second.',
    'Checking. Try not to hover.',
    "On it. Don't touch anything.",
    'Thinking, which makes one of us.',
    'Processing. Patience is a virtue, apparently.',
    'Working on it. Do try to stay calm.',
    'Interesting question. Relatively speaking.',
    "Calculating. This won't take long.",
    "Let me think. Quietly, if you don't mind.",
    'Looking into it. Contain your excitement.',
    'Hold that thought. Carefully.',
    'Checking. Someone has to.',
)

# Spoken when a reply has gone quiet for a while (main decides when).
PROGRESS = (
    'This is taking longer than I anticipated. Unlike some, I finish what I start.',
    'Still working. Thoroughness takes time, a concept you may find unfamiliar.',
    'Bear with me. This one is more involved than you made it sound.',
)
