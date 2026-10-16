# Phantom Orbital Assistant

<p align="center"><img src="docs/phantom-orbital.gif" width="320" alt="Phantom Orbital cycling through idle, listening, thinking and speaking"></p>

Phantom Orbital Assistant is a small floating orb for Windows 11 that you talk to. It is a thin voice and text front end for an AI agent you already run: [Hermes](https://github.com/NousResearch/hermes-agent), OpenClaw, Ollama, LM Studio or any OpenAI-compatible server.

- Type, hold **Ctrl+Shift+Space** to talk, or say a wake phrase ("Hey Megan").
- Speech recognition, wake word, speaker check and the spoken reply all run **locally**. Audio never leaves your PC; only the final transcript text goes to your agent.
- After the agent answers aloud, Orbital listens for five seconds so you can follow up without the wake phrase.
- Only your enrolled voice is accepted (a convenience filter, not security).
- The personality, name, wake phrase and voice come from a swappable **persona pack**. The included persona is Megan.

Orbital keeps the client deliberately thin: your agent owns reasoning, tools and permissions. With Hermes, Orbital shows Hermes's own approval requests as Approve once / Deny cards; it never approves anything by voice.

## Requirements

- Windows 10/11 with a microphone and speakers
- [Node.js](https://nodejs.org) 22 or newer, and Git
- Any Python 3.10+ on `PATH` (used once to bootstrap a project-local copy of `uv`; Orbital then installs its own Python 3.12 inside the project)
- About 3 GB of disk for models
- Optional but recommended: an NVIDIA GPU with CUDA 12 and cuDNN 9 runtime DLLs on `PATH`. Without one, transcription falls back to the CPU and is noticeably slower.
- An AI backend (see [Choose your AI harness](#choose-your-ai-harness))

## Build and run

```powershell
git clone https://github.com/<you>/phantom-orbital.git
cd phantom-orbital
npm ci
powershell -ExecutionPolicy Bypass -File scripts/setup-sidecar.ps1
copy orb.config.example.json orb.config.json   # then edit it, see below
powershell -ExecutionPolicy Bypass -File scripts/setup-models.ps1 -Download
npm run build
npm start
```

- `setup-sidecar.ps1` installs `uv`, Python 3.12 and the voice packages **inside the project folder** (`.tools/`, `sidecar/.venv`). It does not touch your system Python, PATH or registry.
- `setup-models.ps1 -Download` downloads the models once (Whisper large-v3-turbo, the persona's Piper voice, the speaker model and the wake-word model). Downloads are pinned to official sources, and the speaker and wake models are checked by SHA256. After this, Orbital runs fully offline and refuses to download anything at runtime. Re-run it whenever you switch to a persona with a different voice.
- `npm run dev` runs with hot reload instead of `npm start`.

Orbital appears in the lower-right corner. Drag it anywhere; it remembers the spot. The tray icon shows or hides it.

### First use

1. Click **Voice** to cycle the voice mode: **Off → PTT** (push-to-talk plus spoken replies) **→ Voice** (also listens for the wake phrase) **→ Off**. Voice is always Off at startup.
2. Open **Settings → Enroll voice** and read six different short sentences (2–8 seconds each) in a quiet room, holding Ctrl+Shift+Space for each one. Only a numeric voice "fingerprint" is saved, in `%APPDATA%/phantom-orbital/voice-profiles/`; the audio is discarded.
3. Hold **Ctrl+Shift+Space**, speak, release. Or switch to **Voice** mode and say "Hey Megan, what's on my calendar?"
4. **Ctrl+Alt+M** turns voice off immediately from anywhere.

In Text mode, Ctrl+Shift+Space opens the text box instead.

## Configure: `orb.config.json`

`orb.config.json` is your local file (gitignored). `orb.config.example.json` shows every option.

```json
{
  "persona": "personas/megan",
  "user": { "name": "Alex" },
  "harness": { "type": "hermes", "profile": "megan" }
}
```

| Field | Meaning |
|---|---|
| `persona` | Folder of the persona pack to use (relative to the project, or absolute). |
| `user.name` | Your name. It fills `{{user}}` in the personality and labels your messages. |
| `harness` | Which AI backend Orbital talks to. |

Restart Orbital after editing. If something in the file is invalid, Orbital starts anyway and shows the problem in its caption.

## Choose your AI harness

### Hermes

```json
"harness": { "type": "hermes", "profile": "megan" }
```

- Enable Hermes's API server and set `API_SERVER_KEY` in that profile's `.env`. Orbital reads the key from there and keeps it in the Electron main process only.
- Orbital finds Hermes in `HERMES_HOME`, or `%LOCALAPPDATA%\hermes` if that isn't set. Set `"home"` to use another location.
- With `profile`, Orbital talks only to `http://127.0.0.1:8642/p/<profile>` and uses only that profile's key. Leave `profile` out to use the default profile.
- `endpoint` overrides the address, but it must still be on `127.0.0.1`.
- Hermes keeps the personality itself, in the profile's `SOUL.md`; see [Personas](#personas).

### OpenClaw, Ollama, LM Studio and other OpenAI-compatible servers

```json
"harness": {
  "type": "openai",
  "endpoint": "http://127.0.0.1:11434/v1",
  "model": "llama3.1",
  "apiKeyEnv": "MY_API_KEY_VARIABLE",
  "sendPersonality": true
}
```

- `endpoint` is the base URL that ends in `/v1`; Orbital calls `<endpoint>/chat/completions` with streaming. Plain `http` is allowed only for this PC (`127.0.0.1` or `localhost`); anything remote must use `https`.
- The key is optional and read from an environment variable (`apiKeyEnv`) or a file (`apiKeyFile`). Orbital refuses a key written directly into the config.
- With `sendPersonality: true`, the persona's `personality.md` is sent as the system prompt. Turn it off when the server already has its own persona, as an OpenClaw agent does.
- Orbital keeps the last 40 messages of the conversation in memory. They are cleared by **New conversation** or after a period of inactivity.
- There are no approval cards on this harness. Whatever tools the server runs, it runs under its own rules.

**OpenClaw:** enable the gateway's OpenAI-compatible chat-completions endpoint (it is off by default), then point `endpoint` at the gateway's `/v1` (the example config uses the default gateway port) and set `apiKeyEnv` to a variable holding your gateway token. Check the OpenClaw documentation for the current setting names and the `model` value that selects your agent.

## Personas

A persona pack is a folder with two files:

```
personas/megan/
  persona.json      name, wake phrase, voice, filler lines
  personality.md    who the assistant is (system prompt)
```

### `persona.json`

```json
{
  "name": "Megan",
  "wakePhrase": "Hey Megan",
  "voice": { "model": "en_US-amy-medium", "lengthScale": 0.7, "noiseScale": 0.5, "noiseW": 0.8, "volume": 0.65 },
  "fillers": ["Let me think about that.", "One moment. Genius takes a second."]
}
```

| Field | Meaning |
|---|---|
| `name` | Shown on replies; fills `{{name}}` in the personality. |
| `wakePhrase` | 2–4 plain English words. See [Wake phrase](#wake-phrase). |
| `voice.model` | Any [Piper voice](https://huggingface.co/rhasspy/piper-voices) id, such as `en_GB-alba-medium` or `en_US-lessac-high`. |
| `voice.lengthScale` | Speaking speed: below 1 is faster, above 1 slower (Megan uses 0.7). |
| `voice.noiseScale`, `voice.noiseW` | Expressiveness and timing variation (0–1.5). |
| `voice.volume` | Output volume, from 0.05 to 1. |
| `fillers` | Short lines spoken while the agent is thinking (up to 40, each at most 80 characters). Use `[]` for none. |

### `personality.md`

Plain text describing who the assistant is. `{{name}}` and `{{user}}` are filled in for you. Orbital speaks replies aloud, so tell the assistant to answer in plain sentences without Markdown, lists or emojis. Megan's file shows one way to say it.

- **Hermes:** Hermes reads the personality from the profile's `SOUL.md`, not from Orbital. Print the filled-in text with:

  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/render-personality.ps1 -Out soul.md
  ```

  Then review `soul.md` and paste it into `<HERMES_HOME>\profiles\<profile>\SOUL.md`. Back up the old file first; Orbital never edits Hermes files itself.
- **OpenAI-compatible:** sent automatically when `sendPersonality` is true.

### Make your own persona

1. Copy `personas/megan` to `personas/<yourname>`.
2. Edit `persona.json` with the name, wake phrase and voice, then rewrite `personality.md`.
3. Point `"persona"` in `orb.config.json` at the new folder.
4. If you changed the voice, run `scripts/setup-models.ps1 -Download` to fetch it.
5. For Hermes, render the personality into the profile's `SOUL.md`.
6. Restart Orbital.

**Choosing a voice:** listen to samples at <https://rhasspy.github.io/piper-samples/>. The voice id is the file name without `.onnx`, as `<language>_<REGION>-<name>-<quality>`. `medium` is a good balance of quality and speed. To try a voice without changing personas, use `scripts/setup-models.ps1 -Download -Voice en_GB-alba-medium`. Check each voice's model card for its license before sharing recordings made with it.

Please keep personas original. Don't ship packs that imitate real people or copyrighted characters.

### Wake phrase

Wake detection uses a small keyword-spotting model that can spell **any** English phrase with no training. To check that the model can spell your phrase:

```powershell
sidecar\.venv\Scripts\python.exe -X utf8 sidecar\wake.py --keyword sidecar\models\wake "Hey Nova"
```

It prints the token spelling, or an error if the phrase can't be used.

- **Good phrases** are two or three words and 3–5 syllables in total, and don't sound like everyday speech ("Hey Nova", "OK Juniper").
- **Single words** are rejected. Very common phrases ("Hey you") trigger falsely.
- Orbital removes the wake phrase from the start of what you said before sending it, so your agent only sees the command.
- Test your phrase in a few rooms and voices. This is a light model, and detection varies.

## Reminders (optional)

While Orbital is visible it writes a heartbeat to `%APPDATA%/phantom-orbital/reminders/presence.json` every 2 seconds. Any script or agent can show a reminder in Orbital by dropping a JSON file into `%APPDATA%/phantom-orbital/reminders/inbox/`:

```json
{ "title": "Reminder", "message": "Stretch your legs.", "url": "" }
```

Orbital shows it with a chime and a **Got it** button. If the heartbeat is stale, Orbital isn't showing, so use a Windows toast instead.

## Privacy and safety

- Microphone audio, voice profiles, transcription and speech synthesis stay on your PC. There is no cloud speech service and no fallback to one.
- The agent's API key stays in Electron's main process. It is never sent to the user interface, the voice process, logs or URLs.
- The speaker match is a convenience filter. It is not authentication. Don't let it guard anything important.
- Only enroll your own voice. Record other people only with their consent.

## Development

```powershell
npm test                                                   # TypeScript tests (mocked backend, no audio)
sidecar\.venv\Scripts\python.exe -m pytest sidecar/tests   # Python tests
$env:ORB_TEST_LOCAL_MODELS='1'; sidecar\.venv\Scripts\python.exe -m pytest sidecar/tests   # also real local models
npm run typecheck
node scripts/mock-hermes.mjs                               # fake Hermes server for manual testing
```

To regenerate the README animation, see `scripts/readme-gif/README.md`.

Layout: `src/main` (Electron main: config, harness adapters, voice control), `src/renderer` (orb visuals and controls), `sidecar/` (Python voice process: VAD, Whisper, Piper, speaker check, wake word), `personas/`, `scripts/`.

## Credits and licenses

- Speech recognition: [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (MIT) with Whisper large-v3-turbo weights (MIT).
- Text to speech: [Piper](https://github.com/OHF-Voice/piper1-gpl) (GPL-3.0), installed as a separate Python package. Voices come from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices); each voice has its own license on its model card.
- Wake word: k2-fsa / icefall contributors, sherpa-onnx GigaSpeech 3.3M keyword-spotting model, 2024-01-01 (Apache-2.0); [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) runtime (Apache-2.0).
- Speaker model: WeSpeaker team, VoxCeleb ResNet34 pretrained speaker model, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) ([source](https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md)). Orbital uses sherpa-onnx's metadata-adapted [release artifact](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx) (SHA256 `5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94`) without further changes.
- Voice activity detection: Silero VAD (MIT), bundled with faster-whisper.

## License

Phantom Orbital Assistant is free software under the [GNU General Public License v3.0 or later](LICENSE). It uses Piper (GPL-3.0) for speech synthesis, so forks and redistributions must stay GPL-compatible. Third-party models keep their own licenses, listed above.
