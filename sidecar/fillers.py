"""Short local Amy lines that fill the silence while Hermes is thinking.

Edit freely: keep them short (about a second at Amy's rate) and free of the
user's name. They play before the request is understood, so each must fit a
question and a command alike ("Checking" or "Good question" would not).
They are synthesized locally and cached in memory only.
"""
PHRASES = (
    'One moment. Genius takes a second.',
    'Give me a moment. Try not to hover.',
    "On it. Don't touch anything.",
    'Thinking, which makes one of us.',
    'Processing. Patience is a virtue, apparently.',
    'Working on it. Do try to stay calm.',
    'Understood. Brace yourself for competence.',
    "Got it. This won't take long.",
    "One second. Quietly, if you don't mind.",
    'Handling it. Contain your excitement.',
    'Right away. Well, nearly.',
    'Leave it with me. Someone has to.',
)

# Spoken when a reply has gone quiet for a while (main decides when).
PROGRESS = (
    'This is taking longer than I anticipated. Unlike some, I finish what I start.',
    'Still working. Thoroughness takes time, a concept you may find unfamiliar.',
    'Bear with me. This one is more involved than you made it sound.',
)
