# Audio transcription

Zero can turn Telegram voice notes, audio files, video notes and videos into text.
Transcription is **optional**:

| Option                                         | Where to set it                                | Notes                                                                                                                                |
| ---------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **No transcription**                           | Setup wizard or **Settings → Video and voice** | Zero still answers text, images and documents. Audio messages get a short notice instead of an error.                                |
| **ClipSE Whisper** (one or more servers)       | Setup wizard or **Settings → Video and voice** | Self-hosted Whisper. Several servers are load balanced with failover.                                                                |
| **Home Assistant speech-to-text, per profile** | **Users → profile → Voice**                    | Uses any STT engine installed in Home Assistant (Whisper add-on, Wyoming, cloud). Overrides the global choice for that profile only. |
| Compatible `audio_file` service                | **Settings → Video and voice**                 | Legacy option for services that accept an `audio_file` multipart field and return `{ "text": "…" }`.                                 |

Home Assistant **Assist** voice requests do not depend on these settings: Home
Assistant does its own speech recognition and sends Zero the text.

## How Zero picks an engine

1. If the profile has its own Home Assistant STT engine, Zero uses it.
2. Otherwise Zero uses the global setting: none, ClipSE Whisper or a compatible service.
3. With **none**, audio and video messages receive a notice explaining that
   transcription is not configured; the job does not fail.

The per-profile Home Assistant option needs a working Home Assistant connection for
that profile. Zero converts the audio to 16 kHz mono PCM with FFmpeg and streams it
to the selected engine.

## ClipSE Whisper as a standalone service

[ClipSE](https://github.com/fixtse/ClipSE) ships its Whisper service as a separate
container (`ghcr.io/fixtse/clipse-ai`). You can run it on its own, without the rest
of ClipSE, and point Zero at it. It exposes:

- `POST /transcribe` — multipart `file`, optional `model`, `provider` and `language`;
  returns `{ "text": "…", "segments": [...], "language": "…" }`.
- `GET /health` — readiness, default provider/model and whether it is busy.

### CPU (any machine)

Create a folder, for example `clipse-whisper/`, with this `compose.yaml`:

```yaml
services:
  clipse-whisper:
    image: ghcr.io/fixtse/clipse-ai:latest
    container_name: clipse-whisper
    restart: unless-stopped
    environment:
      WHISPER_PROVIDER: faster-whisper
      WHISPER_MODEL: small # small, medium or large-v3-turbo
      WHISPER_DEVICE: cpu
      WHISPER_COMPUTE_TYPE: int8
      WHISPER_CPU_FALLBACK: 'true'
      HF_HOME: /models/whisper
      HUGGINGFACE_HUB_CACHE: /models/whisper/hub
    ports:
      - '8000:8000'
    volumes:
      - ./models:/models
    healthcheck:
      test:
        [
          'CMD-SHELL',
          'python -c "import urllib.request; urllib.request.urlopen(''http://127.0.0.1:8000/health'', timeout=2).read()"',
        ]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s
```

```sh
mkdir -p models/whisper
docker compose up -d
curl http://localhost:8000/health
curl -F file=@sample.ogg http://localhost:8000/transcribe
```

The first request downloads the model into `./models/whisper`, so it is slower.
`small` is a good CPU default; `medium` is more accurate but noticeably slower.

### NVIDIA GPU

Install the NVIDIA driver and the NVIDIA Container Toolkit, then change the service:

```yaml
runtime: nvidia
environment:
  WHISPER_PROVIDER: faster-whisper
  WHISPER_MODEL: large-v3-turbo
  WHISPER_DEVICE: cuda
  WHISPER_COMPUTE_TYPE: float16
  WHISPER_CPU_FALLBACK: 'false'
  NVIDIA_VISIBLE_DEVICES: all
  NVIDIA_DRIVER_CAPABILITIES: compute,utility
  HF_HOME: /models/whisper
  HUGGINGFACE_HUB_CACHE: /models/whisper/hub
```

### Hailo accelerators

Use the `ghcr.io/fixtse/clipse-ai-hailo` image and follow the Hailo section of
ClipSE's [`DOCKER.md`](https://github.com/fixtse/ClipSE/blob/main/DOCKER.md). In
Zero, choose **Hailo** as the Whisper engine to send `provider=hailo`.

### Building the image yourself

```sh
git clone https://github.com/fixtse/ClipSE.git
cd ClipSE
docker compose -f docker-compose.yml -f docker-compose.build.yml build ai
```

### Connect Zero

In the setup wizard (**Initial setup → Transcription**) or in
**Settings → Video and voice**:

1. Select **ClipSE Whisper**.
2. Enter the full URL, including `/transcribe`, e.g.
   `http://192.168.1.20:8000/transcribe`. When Zero runs in the same Compose
   project, use the service name: `http://clipse-whisper:8000/transcribe`.
3. Optionally choose the Whisper engine (Faster Whisper or Hailo), the model and a
   recognition language. **Service default** leaves the choice to ClipSE, and
   **Detect automatically** lets Whisper detect the language.

Keep the Whisper service on a private network. It has no authentication; do not
expose port 8000 to the internet.

## Several ClipSE Whisper servers (load balancing)

A single ClipSE Whisper instance processes one transcription at a time. To serve
more people, or to keep transcription working while one machine is offline, add
several servers. They must be interchangeable (same API; ideally the same model).

- In the wizard, use **Add server** for each URL.
- In **Settings → Video and voice**, the first URL goes in
  **Audio transcription URL** and the rest in **Additional ClipSE Whisper sources**
  (one URL per line).
- In a configuration file:

  ```json
  {
    "media": {
      "asrProvider": "clipse-whisper",
      "asrUrl": "http://whisper-a:8000/transcribe",
      "asrUrls": ["http://whisper-b:8000/transcribe", "http://192.168.1.30:8000/transcribe"]
    }
  }
  ```

How requests are distributed:

- **Round robin.** Each transcription starts at the next server in the list.
- **Bounded failover.** Connection errors, timeouts, HTTP 429 and 5xx answers move
  the request to the next server. Each server is tried at most once per request.
  A 4xx answer (for example, unreadable audio) is returned immediately.
- **Cooldown.** A server that just failed is tried last for the next 30 seconds,
  so one offline machine does not delay every message.
- Each attempt has a 120-second timeout.

Up to 16 sources are supported. Duplicate URLs are ignored.

## Turning transcription off

Choose **No transcription** in the wizard or in **Settings → Video and voice**.
Saved URLs are kept, so you can switch back later without typing them again.
Profiles with their own Home Assistant STT engine keep transcribing.
