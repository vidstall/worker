# bot

A headless fake participant used to test/demo the room UI. It registers on
Sui, then either creates a NEW room or joins an EXISTING one (password-gated
at the relay layer, default `123`), resolves that room's real relay endpoint
on-chain, and optionally publishes a looping MP4 file as its video and/or
audio, so a real user who opens the room's join link sees the bot's video
and/or hears its audio playing.

It never touches `services/contract` beyond the existing `user_registry`/
`room_manager` read/write calls below — it's a test tool, not part of system
logic.

Manually-run dev/demo tool — not IaC-managed (see the design decision in the
implementation plan). Run it with `pnpm --filter bot dev`/`start` (HTTP
control server) or build the standalone `Dockerfile`.

## Server mode (default)

`pnpm --filter bot dev` / `start` starts an HTTP control server so an admin
dashboard (or curl) can launch/list/stop bot sessions on demand, instead of
the old one-shot CLI script. Each session independently chooses:

- **Room mode**: `create` a new room, or `join` an existing room by `roomId`.
- **Media mode**: `listen` (no produce), `camera` (video only), `mic` (audio
  only), or `both`.

### HTTP API

All routes except `/healthz` require `Authorization: Bearer <BOT_CONTROL_TOKEN>`
when `BOT_CONTROL_TOKEN` is set. If it's unset, the control API is
**unauthenticated** — a loud warning is logged at startup. Always set
`BOT_CONTROL_TOKEN` outside of local dev.

- `GET /healthz` — always `200`, no auth.
- `POST /bots` — start a session.
  Body: `{ roomMode: 'create'|'join', roomId?: string, mediaMode: 'listen'|'camera'|'mic'|'both', mp4Path?: string }`
  (`roomId` required + non-empty when `roomMode` is `join`).
  Response: `201 { botId, roomId, joinUrl }`, or a `4xx`/`502` with a clear
  error message on validation/session-start failure.
- `GET /bots` — list active sessions:
  `[{ id, roomId, mediaMode, joinUrl, uptimeMs }]`.
- `DELETE /bots/:id` — stop and remove a session. `204` on success, `404` if
  not found.

### What a session does

1. Registers the bot's Sui address (`user_registry::register_user`, ignoring
   "already registered" — idempotent, safe across sessions).
2. `roomMode: 'create'` → calls `room_manager::create_room`, then polls
   `room_manager::get_room_assignment` (backoff, ~30s timeout) until
   `cp-daemon`'s `RoomCreated` listener assigns a relay.
   `roomMode: 'join'` → reads the existing room's current assignment
   directly (shorter poll — an active room should already be assigned).
3. Cross-references the assigned relay's `miner_id` against
   `relay_registry::get_active_relays()` to resolve its real `wss://...`
   endpoint (the topology has multiple relays, so a static URL would usually
   be wrong for a given room).
4. Joins that relay over the same `join`/`createTransport`/`produce` WS
   protocol the browser client uses.
5. For each media kind the requested `mediaMode` calls for, spawns a looping
   ffmpeg process (`-stream_loop -1`) decoding `mp4Path` into raw frames,
   feeds them into `@roamhq/wrtc`'s `RTCVideoSource`/`RTCAudioSource`, and
   produces it as a mediasoup track (VP8/Opus). `listen` mode produces
   nothing and spawns no ffmpeg processes.

It does **not** call `room_manager::assign_relay_and_signaling` — that
requires an AdminCap and is handled automatically by `cp-daemon`'s
`RoomCreated` event listener as part of normal running-system behavior, so
`cp-daemon` must be running for a newly-created room to actually get a relay
assigned.

### Example

```bash
curl -sX POST localhost:8095/bots \
  -H "Authorization: Bearer $BOT_CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"roomMode":"create","mediaMode":"both"}'
# => {"botId":"...","roomId":"0x...","joinUrl":"http://localhost:5173/rooms/0x...?pw=123"}

curl -sX DELETE localhost:8095/bots/<botId> -H "Authorization: Bearer $BOT_CONTROL_TOKEN"
```

## One-shot dev mode

For local smoke-testing without the HTTP layer, `pnpm --filter bot dev:once`
runs a single bot session directly (imports `startBotSession` from
`session.ts` — no logic duplicated) and waits until `Ctrl+C`. Overridable via
env: `ROOM_MODE` (`create` default | `join`), `ROOM_ID` (required if
`ROOM_MODE=join`), `MEDIA_MODE` (`listen`|`camera`|`mic`|`both`, default
`both`) — this matches the app's old pre-server default behavior.

## Prerequisites

- `ffmpeg`/`ffprobe` on `PATH`.
- A local Sui network + deployed contracts (so the object IDs below exist).
- `signaling`, `relay`, and `cp-daemon` running.
- The bot's Sui address funded with gas (faucet).

## Environment variables

See `.env.example`. Notably:

- `PRIVATE_KEY` — bech32 Sui secret key, funded with gas.
- `MP4_PATH` — default video file to loop (a session may override per-request).
- `ROOM_PASSWORD` — default `123`.
- `EXPECTED_PARTICIPANTS` — used only for `roomMode: 'create'` sessions.
- `CLIENT_URL` — used to build each session's shareable join link.
- `PORT` — HTTP control server port, default `8095`.
- `BOT_CONTROL_TOKEN` — Bearer token for `/bots*` routes. Unset = unauthenticated
  (dev only, loud startup warning).

## Running

```bash
cp .env.example .env   # fill in PRIVATE_KEY, object IDs, MP4_PATH, BOT_CONTROL_TOKEN
pnpm --filter bot dev
```

Then `POST /bots` as shown above. Open the returned `joinUrl` in the client
webapp, confirm the password, and the looping video/audio should render as
the bot's remote tile.

## Testing

`pnpm --filter bot test` runs the unit tests: pure frame/chunk-slicing math,
chain event-extraction/idempotent-registration/relay-assignment-resolution
logic (mocked `SuiClient` + BCS-encoded fixtures), join-message shape (mocked
WS), session media-mode branching (mocked chain/peer/ffmpeg), and the HTTP
control server's routing/validation/auth (mocked req/res, no real socket).
The live `@roamhq/wrtc`/ffmpeg/relay/chain integration is manual-only,
consistent with the bench harness this app's protocol code was extracted
from (`scripts/bench/mediasoup-client-harness.ts`).
