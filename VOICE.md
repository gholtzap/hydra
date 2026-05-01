# Hydra Voice Local Setup

Hydra voice mode runs a local Pipecat bot with `SmallWebRTCTransport`. The desktop app talks to that bot over localhost WebRTC and the bot can call Hydra MCP tools for sessions, repos, settings, and wiki actions.

This path does not need a Daily API key because Hydra uses Pipecat's peer-to-peer Small WebRTC transport for local desktop voice.

## Requirements

- Python 3.11 or newer.
- `uv` is recommended for local development, matching Pipecat's current setup docs. Install it from `https://docs.astral.sh/uv/getting-started/installation/`.
- Node dependencies installed at the repo root with `npm install`.
- Microphone permission granted to the Electron app when prompted.

## Credentials

The default stack is OpenAI LLM with Deepgram for both STT and TTS. Create these keys before testing voice mode:

- `OPENAI_API_KEY`: create one at `https://platform.openai.com/api-keys` and make sure billing is enabled.
- `DEEPGRAM_API_KEY`: create one from Deepgram Console > Settings > API Keys, or start at `https://console.deepgram.com/signup?jump=keys`.

Optional providers exposed in the UI:

- `ANTHROPIC_API_KEY`: `https://console.anthropic.com/settings/keys`.
- `GOOGLE_API_KEY`: `https://aistudio.google.com/app/apikey`.
- `CARTESIA_API_KEY`: `https://play.cartesia.ai/keys`.
- `ELEVENLABS_API_KEY`: `https://elevenlabs.io/app/settings/api-keys`.

For local development, copy the example file and fill in only the keys you need:

```bash
cp voice/.env.example voice/.env
```

Do not commit `voice/.env`. The desktop app also accepts keys pasted into the Voice settings panel, and those values take precedence over `voice/.env` for that app session.

## Desktop Flow

For normal app testing, start Hydra and click the microphone button:

```bash
npm run dev
```

On first use, Hydra does the Python setup automatically:

- It checks for Python 3.11+.
- It creates an isolated managed environment at `~/.hydra/voice-venv`.
- It installs the minimal default stack from `voice/requirements.txt`, preferring `uv` and falling back to `pip`.
- If you select an optional provider, it installs only that provider's Pipecat extra before starting the bot.
- It validates the selected provider keys before installing or spawning the Pipecat bot.

If setup fails, the Voice modal shows the missing key or Python/install error and links to the relevant provider credential page.

## Standalone Bot

Use this when changing `voice/bot.py` outside the Electron flow:

```bash
cd voice
uv sync
cp .env.example .env
uv run python bot.py --host 127.0.0.1 --port 7860
```

For optional providers in standalone mode, install the matching extra first:

```bash
uv sync --extra cartesia
uv sync --extra elevenlabs
uv sync --extra anthropic
uv sync --extra google
uv sync --extra whisper
```

Hydra's Electron client normally handles the WebRTC offer flow. The standalone command is mainly useful for import errors, dependency validation, and server health checks:

```bash
curl http://127.0.0.1:7860/health
```

## Files

- `voice/bot.py`: Pipecat bot, credential validation, Small WebRTC signaling endpoints, and MCP tool registration.
- `voice/requirements.txt`: minimal default dependencies used by the desktop app's managed environment.
- `voice/pyproject.toml`: development metadata and optional provider extras for `uv sync`.
- `voice/.env.example`: local credential template.
- `electron/main/voice-manager.ts`: Electron-side Python detection, managed venv creation, dependency install, bot spawn, and credential validation.
- `electron/renderer/app.ts`: Voice modal, provider prompts, setup log, and WebRTC client integration.

## Troubleshooting

- `Python 3.11+ is required`: install Python from `https://www.python.org/downloads/`, or on macOS run `brew install python@3.11`.
- Missing key error: add the key in the Voice settings panel, export it in the shell before `npm run dev`, or put it in `voice/.env`.
- Dependency install failure: delete `~/.hydra/voice-venv` and retry voice mode. Hydra will recreate the managed environment.
- First run is slow: Pipecat may download models such as Silero VAD; later runs should be faster.
- Browser/WebRTC error: restart Hydra and confirm microphone permission is granted for Electron.
