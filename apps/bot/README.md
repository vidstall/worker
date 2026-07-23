# bot

A headless fake participant. It creates a real on-chain room (password-gated
at the relay layer, default `123`) and publishes a looping MP4 file as its
video/audio, so a real user who opens the room's join link and enters the
password sees the bot's video playing.

Manually-run dev/demo tool for now — not IaC-managed (see the design decision
in the implementation plan). Run it with `pnpm --filter bot dev`/`start` or
build the standalone `Dockerfile`.

## What it does

1. Registers the bot's Sui address (`user_registry::register_user`, ignoring
   "already registered") and creates a room (`room_manager::create_room`).
2. Logs the room's join URL: `{CLIENT_URL}/rooms/{roomId}?pw={ROOM_PASSWORD}`.
3. Joins that room at the relay (`RELAY_URL`) with the room password, over the
   same `join`/`createTransport`/`produce` WS protocol the browser client uses.
4. Spawns two looping ffmpeg processes (`-stream_loop -1`) decoding `MP4_PATH`
   into raw video (I420) and audio (PCM) frames, feeds them into
   `@roamhq/wrtc`'s `RTCVideoSource`/`RTCAudioSource`, and produces both as
   mediasoup tracks (VP8/Opus, matching the relay's router `mediaCodecs`).

It does **not** call `room_manager::assign_relay_and_signaling` — that
requires an AdminCap and is handled automatically by `cp-daemon`'s
`RoomCreated` event listener as part of normal running-system behavior, so
`cp-daemon` must be running for the room to actually get a relay assigned.

## Prerequisites

- `ffmpeg`/`ffprobe` on `PATH`.
- A local Sui network + deployed contracts (so the object IDs below exist).
- `signaling`, `relay`, and `cp-daemon` running.
- The bot's Sui address funded with gas (faucet).

## Environment variables

See `.env.example`. Notably:

- `PRIVATE_KEY` — bech32 Sui secret key, funded with gas.
- `MP4_PATH` — the video file to loop.
- `ROOM_PASSWORD` — default `123`.
- `RELAY_URL` — static relay WS URL (e.g. `ws://localhost:4000`).
- `CLIENT_URL` — used only to print the shareable join link.

## Running

```bash
cp .env.example .env   # fill in PRIVATE_KEY, object IDs, MP4_PATH
pnpm --filter bot dev
```

Expected log output: registration/room-creation confirmation, the room's
join URL, relay join success, and confirmation that both the video and audio
producers are live. Open the printed join URL in the client webapp, confirm
password `123`, and the looping video should render as the bot's remote tile.

## Testing

`pnpm --filter bot test` runs the unit tests (pure frame/chunk-slicing math,
chain event-extraction/idempotent-registration logic, and join-message shape
with a mocked WS). The live `@roamhq/wrtc`/ffmpeg/relay integration is
manual-only, consistent with the bench harness this app's protocol code was
extracted from (`scripts/bench/mediasoup-client-harness.ts`).
