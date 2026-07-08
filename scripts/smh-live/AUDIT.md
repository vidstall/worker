# Task 1 Audit — SMH-LIVE reused API surface + port map (grounded)

> Read-only investigation of the `smh-live-harness` worktree (branch based on
> `static-mesh-hardening` @ bbb715b). Every signature / string / port below is quoted from the
> real source at the cited `path:line`. Where the plan/design assumed something that the code
> does NOT match, it is called out under a **⚠️ Plan reconciliation** subsection.
>
> Author agent: `smh-live` · scope: Task 1 only (no harness code written).

---

## Step 1 — Programmatic peer surface (`scripts/bench/mediasoup-client-harness.ts`)

**`VirtualPeer` is NOT exported.** `class VirtualPeer` (line 575) is module-internal; only `main()`
constructs it. `RelayClient` (line 478) IS exported, as are `parseArgs`, `peerLabel`,
`buildIceServers`, `startConsumerPoller`, `computeG2GoptB`, and several helpers.

- **Constructor:** `new VirtualPeer(opts: VirtualPeerOptions)` where (lines 562-573):
  ```ts
  interface VirtualPeerOptions {
    relayUrl: string;
    roomId: string;
    peerId: string;
    writer: WriterLike;                 // REQUIRED (LatencyWriter-shaped: .write(metric, ms, ctx?))
    iceServers?: Array<{ urls: string[]; username?: string; credential?: string }>;
  }
  ```
- **`relay-url` + `room-id`:** passed via `opts.relayUrl` / `opts.roomId` (the CLI `--relay-url` /
  `--room-id` map to these through `parseArgs`, lines 402-444). Default relay `ws://localhost:4000`.
- **Track production:** `run()` (line 595) joins → loads `Device({ handlerName: 'Chrome111' })` →
  makes send+recv transports → calls the PRIVATE `startAudioProducer()` (line 694) which creates ONE
  silent `@roamhq/wrtc` `RTCAudioSource` track and does `this.producer = await this.sendTransport.produce({ track })` (line 726).
- **Produce a NEW track AFTER join?** **NO public method exists.** Producing is a one-shot inside
  `run()` via the private `startAudioProducer()`; `this.producer` is a single field that would be
  overwritten. There is no `produce()` / `produceNew()` public API.
- **Minimal extension point (do NOT implement now):** `startAudioProducer()` (line 694) is the exact
  method that would be re-invoked (create a fresh `RTCAudioSource` + track, `sendTransport.produce`)
  to publish a second track mid-session for the D3 during-window publish. `sendTransport` and
  `client` are private fields, so the peer must be **exported and given a public method** for a wrapper
  to drive it.

### ⚠️ Plan reconciliation — Step 1
- **Task 6's premise "reuse/wrap `VirtualPeer`" requires an ADDITIVE edit to the harness**, because
  `VirtualPeer` is not exported and its produce path is private. The plan says "do NOT edit
  `mediasoup-client-harness.ts` unless unavoidable" — it is unavoidable if we reuse the peer. Minimal
  additive change for Task 6: `export class VirtualPeer` + add a public `async produceNew(): Promise<string>`
  that runs the `startAudioProducer()` body against the existing `sendTransport` and returns the new
  `producer.id`. Alternatively, `media-fleet.ts` re-implements the peer from the exported `RelayClient`
  — more code, zero harness edit. **Controller decides** which; the export+method route is smaller.
- The harness's `main()` ends with `process.kill(process.pid, 'SIGKILL')` (line 862) — that is CLI-only
  (guarded by `isMain`, line 865), NOT triggered on import. Safe to import.
- A `writer` is mandatory. The fleet can pass a no-op `WriterLike` (D2/D3 don't need latency stats).

---

## Step 2 — On-chain helpers (`revote-localnet-helpers.ts` + `localnet-fixture.ts`)

**Exported from `apps/cp-daemon/src/__tests__/integration/revote-localnet-helpers.ts`:**
| Symbol | Signature (abridged) | Purpose |
|---|---|---|
| `bootstrapCp` | `(client, config, logger, stakeMist=CP_STAKE_MIST) => Promise<BootstrapCpResult>` | register+enroll the first CP (0.6 SUI) |
| `registerMiner` | `(client, kp, config, stakeMist, logger) => Promise<RegisterResult>` | `registration::register` (User role) |
| `castRoleVoteFromCp` | `(client, cp, minerId, role, config, logger) => Promise<TxStatusLike>` | CP-signed `role_voting::cast_role_vote` |
| `applyVotedRoleAs` | `(client, minerKp, minerCapId, stakeId, config, logger) => Promise<TxStatusLike>` | miner `registration::apply_voted_role` |
| `voteAndApplyRelay` | `(client, cp, config, logger) => Promise<RelayResult>` | FULL relay lifecycle (register→vote→apply→`register_relay`) |
| `createFundedKeypair` | `(logger) => Promise<Ed25519Keypair>` | fresh faucet-funded keypair |
| `waitForEpochAtLeast` | `(client, target, {timeoutMs}, logger) => Promise<bigint>` | epoch poll |
| `CP_STAKE_MIST` = `600_000_000n`, `RELAY_STAKE_MIST` = `300_000_000n` | consts | stake tiers |
| types `BootstrapCpResult` `{kp, minerId, cpCapId, stakeId}`, `RelayResult` `{minerId, minerCapId, stakeId, kp}` | | |

**Exported from `apps/cp-daemon/src/__tests__/integration/localnet-fixture.ts`:**
- `bootLocalnet(opts?: { epochDurationMs?; portWaitMs? }) => Promise<LocalnetHandle>` — **spawns its OWN
  `sui start --with-faucet --force-regenesis`, publishes the package, creates the 6 registries**, returns
  `LocalnetHandle { client, config: NetworkConfig, signer, teardown }` (lines 366-419).
- `fundAddress(address) => Promise<void>` (line 212), `SUI_RPC_URL = 'http://127.0.0.1:9000'` (27),
  `FAUCET_URL = getFaucetHost('localnet')` (28), type `LocalnetHandle` (39).

**How `create_room` / `register_user` / `register_validator` / `register_signaling` actually happen:**
They are **NOT exported helpers** — they are inline in `rms-live-local.integration.test.ts`:
- `register_user`: inline `user_registry::register_user` moveCall (test line 228-233).
- `create_room`: inline `room_manager::create_room` with args `(networkRegistryId, roomManagerId,
  userRegistryId, relay_mode=u8(0 SFU), expected_participants=u64(2), room_class_hint=u8(0))`
  (test lines 234-246); the `RoomCreated` event's `room_id` is read from the tx events.
- validator/signaling registration: the test-local `registerRoleNode()` helper (test lines 86-102) =
  `createFundedKeypair`→`registerMiner(0.3 SUI)`→`castRoleVoteFromCp`→`applyVotedRoleAs`→inline enroll.

### ⚠️ Plan reconciliation — Step 2  (TWO significant items)
1. **`bootLocalnet` is INCOMPATIBLE with `run-rms-live-local.ps1`.** Both boot `sui` on :9000 AND
   publish the package + create registries. The design's "reuse the boot" and Reuse-map row for
   `bootLocalnet` cannot be used by this harness — the orchestrator boots via the ps1 script
   (`network` + `deploy`) and must build its `NetworkConfig` from the `.env` the script writes
   (`dvconf-daemons/.env`: `PACKAGE_ID`, `*_REGISTRY_ID`, `ROOM_MANAGER_ID`, `USER_REGISTRY_ID`,
   `ROLE_VOTE_BOX_ID`, `MINER_STORE_ID` …). Only the STATELESS helpers (`registerMiner`,
   `castRoleVoteFromCp`, `applyVotedRoleAs`, `createFundedKeypair`, `bootstrapCp`, `voteAndApplyRelay`)
   are reusable — they take a `client`+`config` and boot nothing.
2. **In the native rig the relays/validators/cp/signaling REGISTER THEMSELVES** (voting-mode boot, see
   Step 5) — so the orchestrator must NOT call `bootstrapCp` / `voteAndApplyRelay` /
   `registerRoleNode` for those or it DOUBLE-registers. The helpers the orchestrator actually needs
   are the **USER side only**: `register_user` + `create_room` (+ **`create_escrow`**, see Step 3
   trigger) — replicated inline (patterns exist: the test for user/room; `scripts/load-test.ts:126-159`
   `createEscrow` → `economic_layer::create_escrow`). This narrows Task 2/Task 8 scope materially.

---

## Step 3 — cp-daemon log strings + attested feed

**`placement_basis` (`apps/cp-daemon/src/event-handler.ts:489-497`):**
```ts
const basis = !feedActive
  ? 'legacy-self-report'
  : capacities.some((c) => c.canaryHealthy) ? 'attested' : 'defer';
logger.info(
  { module: 'event-handler', action: 'placement_basis',
    context: { basis, feedRows: attestedLoad?.size ?? 0, candidates: capacities.length } },
  'REQ-RMS-022: placement capacity basis',
);
```
- `action === 'placement_basis'`, **`basis` lives under `context.basis`** — the plan's
  `readPlacementBasis(o.action === 'placement_basis' → o.context.basis)` is **CORRECT as written**.
- Values: `'legacy-self-report'` (feed OFF), `'attested'` (feed wired + ≥1 healthy row), `'defer'`
  (feed wired but ZERO attested rows). D1a→`'defer'`, D1b→`'legacy-self-report'` — both **confirmed**.

**`attested-load poller started` (`apps/cp-daemon/src/index.ts:1162-1168`):**
```ts
const attestedPlacementActive = process.env['RMS_ATTESTED_PLACEMENT'] === '1';
if (attestedPlacementActive) {
  const feedUrl = process.env['RMS_LOAD_FEED_URL'] ?? 'http://127.0.0.1:8102/canary/load';
  const feedPollMs = parseInt(process.env['RMS_LOAD_FEED_POLL_MS'] ?? '5000', 10);
  attestedLoadPoller = startAttestedLoadPoller({ feedUrl, pollMs: feedPollMs, logger });
  logger.info({ module: 'cp-daemon', feedUrl, feedPollMs },
    'REQ-RMS-022: attested-load poller started (RMS_ATTESTED_PLACEMENT=1)');
}
```
- Flag `RMS_ATTESTED_PLACEMENT=1`. Feed URL default `http://127.0.0.1:8102/canary/load`
  (overridable via `RMS_LOAD_FEED_URL`). Emitted `msg` contains `attested-load poller started`
  (substring grep OK); `module: 'cp-daemon'`.

**`/canary/load` route (`apps/validator-daemon/src/canary/coverage-server.ts:215-225`):** returns
`404 {"error":"load feed disabled"}` when `args.loadProvider` is undefined, else `200` +
`buildLoadPayload(acc, heartbeatFresh, reporterMinerId)`. Port env
`VALIDATOR_CANARY_COVERAGE_PORT` **default `8102`** (`apps/validator-daemon/src/index.ts:512`), bound
loopback-only `127.0.0.1` (coverage-server.ts:238). `buildLoadPayload` (coverage-server.ts:143-148)
maps `[...acc.byRelay.entries()]` → with an EMPTY accumulator gives **`relays: []`** — so the
flag-ON D1a assert `relays:[]` holds while M4b supplies no live captures. (Note: the flag that serves
`relays:[]` is really "feed wired + empty accumulator"; `RMS_ATTESTED_PLACEMENT=1` is on the **cp**
side and makes the cp POLL the feed, driving `basis='defer'`.)

**Where cp writes its log under the native rig:** `run-rms-live-local.ps1` launches the cp with
`... && pnpm dev:cp > "$logFile" 2>&1` where `$logFile = <Root>\.logs\cp-1-<yyyyMMdd-HHmmss>.log` and
`<Root> = C:\Thesis\dvconf` (the dir holding the ps1). So **stdout+stderr → `C:\Thesis\dvconf\.logs\cp-1-*.log`**
(pick newest by name). Relay logs → `C:\Thesis\dvconf\.logs\relay-{1..N}-*.log`.

### ⚠️ Plan reconciliation — Step 3  (D1a is BLOCKED as-is — highest-priority finding)
1. **The validator coverage server (`:8102`) does NOT start under `run-rms-live-local.ps1`.** It is
   gated on `CANARY_CELL_SECRET` (hex): `apps/validator-daemon/src/index.ts:448-456` throws
   `"CANARY_CELL_SECRET unset/empty — canary cell loop requires a salt"` when unset, and that throw
   skips the WHOLE `startCanaryCellLoop` + `startCoverageServer` block (caught at index.ts:530-531).
   The ps1 sets NO `CANARY_*` env on the validator arm (Step 5). ⇒ **`curl :8102/canary/load` returns
   nothing (server absent), so D1a cannot pass as-is.** Task 8/9 must inject `CANARY_CELL_SECRET=<hex>`
   (+ ensure `VALIDATOR_CANARY_COVERAGE_PORT`) into the validator boot — a **script-only** env
   pass-through in `run-rms-live-local.ps1`'s validator arm, no daemon-code edit.
2. **Port 8102 is double-booked.** `run-rms-live-local.ps1` sets `VALIDATOR_HEALTHZ_PORT = 8100 + Index`
   → validator-2's healthz = **8102**, which collides with the coverage-server default **8102**. When
   the coverage server is enabled it must run on the CP-co-located validator (validator-1, which also
   has `RELAY_METRICS_URL` wired) and bind 8102, while validator-2's healthz also wants 8102 →
   EADDRINUSE. Task 8 must give validator-1 an explicit `VALIDATOR_CANARY_COVERAGE_PORT` free of the
   healthz band (and point the cp's `RMS_LOAD_FEED_URL` at it), OR shift the healthz base. Either way
   8102 (and whatever coverage port is chosen) goes into the Task-2 pre-flight scan set.
3. **Native placement trigger = `economic_layer::EscrowCreated`, not `create_room`.** event-handler.ts
   header (lines 121-123) + `case 'EscrowCreated'` (line 362): "Room assignment is deferred until
   EscrowCreated is received." `RoomCreated` only stashes the room. ⇒ the orchestrator MUST create a
   REAL on-chain escrow after `create_room` to make the native cp assign + emit `placement_basis` /
   `RoomAssigned`. The integration test SIDESTEPS this (it synthesizes a fake `EscrowCreated` and calls
   `handleEvent` in-process) — but this harness drives the native cp, so a real
   `economic_layer::create_escrow` is required (pattern: `scripts/load-test.ts:126-159`).
4. **Log format risk (load-bearing for `log-asserts`).** `packages/shared/src/logger.ts:38-63`: default
   is JSON-to-stdout, BUT `pretty` also turns ON when `NODE_ENV=development` or `LOG_LEVEL=debug/trace`
   (line 42-44). The ps1 `.env` sets `LOG_LEVEL=info` (safe) and no `LOG_PRETTY`, but if `pnpm dev:cp`
   sets `NODE_ENV=development` the logs become pino-pretty and `JSON.parse` per line FAILS. Task 8
   should force `LOG_PRETTY=false` on the cp+relay boot env (script-only) to guarantee raw JSON.

---

## Step 4 — D3 inter-relay link (`inter-relay-link.ts` + `inter-relay.ts` + relay wiring)

- **Which host:port the STANDBY dials:** the standby OPENS the link to the **PRIMARY's WS URL resolved
  from chain (RoomTopology.primaryEndpoint / endpoint cache)** — and this **reuses the primary's existing
  client-signaling WS server port, NO new port** (`inter-relay.ts` header lines 14-24; `inter-relay-link.ts`
  header lines 5-13). For the deterministic primary = relay-1, that is **`ws://127.0.0.1:4000`** (relay-1's
  `WS_PORT`; the run script comments relay-1/ws4000 is "the cp's deterministic primary", ps1 line 751).
  The dial carries subprotocol `INTER_RELAY_SUBPROTOCOL = 'dvconf-inter-relay.v1'` (inter-relay.ts:53) +
  `Authorization: Bearer <INTER_RELAY_TOKEN>` + `x-inter-relay-peer-id`.
- **`onOpen(url, isReopen)` signature:** `onOpen?: (url: string, isReopen: boolean) => void`
  (`inter-relay-link.ts:137`). `isReopen=false` on first open per url; `true` on every later (re)open
  (`createStandbyLinkManager`, lines 165-177; `everOpened` set).
- **Exact re-delivery log strings (TWO emitted on reopen):**
  - STANDBY coordinator: `inter-relay.ts:1659` →
    `'REQ-RMS-037: re-delivered stored reverse announces on link reopen'`
    (fields `{ roomId, count }`). **The plan's grep target
    `REQ-RMS-037: re-delivered stored reverse announces` is a SUBSTRING of this → `sawReopenRedelivery`
    `.includes(...)` WILL match.**
  - Relay wiring layer: `apps/relay/src/index.ts:581` →
    `'REQ-RMS-037: link reopen -- stored reverse announces re-delivered'` (field `{ url }`) — this is
    the "standby-side variant" the plan mentioned. Either line proves reopen re-delivery; grep for
    `REQ-RMS-037` + `re-deliver` catches both.
  - Reopen wiring: `apps/relay/src/index.ts:572-582` — `onOpen: (url, isReopen) => { if (!isReopen) return;
    for (roomId of standbyWarmPipe.roomsWithStoredAnnounces()) standbyWarmPipe.resendReverseAnnounces(roomId); ... }`.
    The re-delivery therefore fires on the **STANDBY relay's** log (e.g. `relay-2-*.log` / `relay-3-*.log`),
    NOT the primary's. Grep ALL `relay-*.log` for robustness.
- **`readyState !== OPEN` silent-drop:** `createStandbyLinkManager.send()` (`inter-relay-link.ts:201-219`):
  no socket → `debug 'send dropped — no link attached'`; `socket.readyState !== WebSocket.OPEN` →
  `debug 'send dropped — link not OPEN'`; a throwing `send` → `warn` swallowed. The primary-side
  `createWsInterRelaySender` (`inter-relay.ts:408-430`) mirrors it (`WS_OPEN = 1`). So while the link is
  down the live reverse-announce is silently dropped, but its args are STORED in
  `sentReverseAnnounces` (inter-relay.ts:902-913) and re-sent by `resendReverseAnnounces` (line 1648) on
  reopen — the primary's `reverseMintedIds` dedup makes the re-delivery idempotent.

### ⚠️ Plan reconciliation — Step 4  (D3 chaos mechanism has a real precision gap)
1. **The "standby-dial port" is NOT a dedicated inter-relay port — it is the PRIMARY's client WS port
   (4000).** The design/plan Risk #3 assumed netsh could isolate a distinct link port; in reality the
   inter-relay link shares the primary's client-signaling WS server. Consequences for `chaos.ps1`
   (Task 7) + D3 (Task 11):
   - Blocking outbound→remoteport 4000 on the (single, loopback) host drops the standby→primary
     inter-relay dial AND any local client (media-fleet peer) homed to the primary relay-1. Orchestration
     must ensure the D3 during-window PUBLISHER peer is homed to the STANDBY (ws 4002/4004), and accept
     that a primary-homed fleet peer's signaling also drops during the window (or home no fleet peer to
     the primary during D3).
   - **netsh advfirewall may not filter pure loopback** (design Risk #3, still open). The verified
     fallbacks: (a) a userspace TCP pause-proxy the standby dials THROUGH — but the standby resolves the
     primary URL from the on-chain endpoint (`ws://127.0.0.1:4000`), so interposing a proxy needs the
     registered endpoint to point at the proxy port (not trivially injectable), or (b) kill+hold the
     primary's :4000 listener — but that is D2 (kill-relay/failover), not a transient link flap. Task 7
     MUST verify the link actually went `NOT-OPEN` (assert, not assume) before publishing, and the chosen
     mechanism must be recorded in this AUDIT once proven live. **This is the largest open risk in the plan.**

---

## Step 5 — `run-rms-live-local.ps1` port surface + contract

**Location:** `C:\Thesis\dvconf\run-rms-live-local.ps1` (WORKSPACE ROOT — NOT inside `dvconf-daemons`).
`$Root = <dir of the ps1> = C:\Thesis\dvconf`; `$Daemons = C:\Thesis\dvconf\dvconf-daemons` (the MAIN
repo, not this worktree — see reconciliation). `$LogsDir = C:\Thesis\dvconf\.logs`,
`$PidFile = C:\Thesis\dvconf\.dvconf-pids`, `$RpcUrl = http://127.0.0.1:9000`.

**Sub-command contract:** `param([ValidateSet("all","network","deploy","daemons","client","status","stop")] $Action="all")`
plus `-RelayCount 3` `-ValidatorCount 4` `-CpCount 1` `-SignalingCount 1` `-SkipSetup`.
- `network` → `sui start --with-faucet --force-regenesis` in a new window, polls :9000.
- `deploy` → publish + create 6 registries + fund/mint + writes `dvconf-daemons\.env` (appends
  `RMS_KR_MIN=3`) + writes client `.env`.
- `daemons` → launches cp (first, +25s settle) → signaling → relays → validators, ALL voting-mode,
  self-registering. `> <logfile> 2>&1` per daemon.
- `status` → port dashboard (3s settle). `stop` → `Stop-All`.
- `client` → Vite :5173 (NOT needed by the harness).

**Full port table (all DERIVED from hardcoded bases — see reconciliation):**
| Port(s) | Label | Source (ps1) | Env-overridable? |
|---|---|---|---|
| `9000` | Sui RPC | hardcoded `http://127.0.0.1:9000` / `sui start` | **NO** |
| `9123` | Sui faucet | hardcoded `http://127.0.0.1:9123/gas` | **NO** |
| `8080` | Signaling (index 1) | hardcoded `Port = 8080` (line 588) | **NO** for the single instance (index>1 uses `SIGNALING_PORT`) |
| `5173` | Vite client | hardcoded (Start-Client) | **NO** (harness doesn't launch it) |
| `4000,4002,4004` | Relay WS (`4000+(i-1)*2`) | computed, set via `WS_PORT` (line 540) | script-computed; not settable via pre-set env (script overwrites) |
| `4001,4003,4005` | Relay metrics (`4001+(i-1)*2`) | `METRICS_PORT` (line 541) | same |
| `10000-10100 / 10200-10300 / 10400-10500` | Relay RTC (`10000+(i-1)*200 .. +100`) | `RTC_MIN_PORT`/`RTC_MAX_PORT` (542-543) | same |
| `40000-40099 / 40100-40199 / 40200-40299` | Inter-relay pipe (`40000+(i-1)*100 .. +99`) | `PIPE_PORT_RANGE` (544-545) | same |
| `8101,8102,8103,8104` | Validator healthz (`8100+Index`) | `VALIDATOR_HEALTHZ_PORT` (line 747) | script-computed |
| `8102` (default) | **Validator canary `/canary/load`** | `VALIDATOR_CANARY_COVERAGE_PORT` default 8102 | **NOT set by ps1** (server not started — Step 3) |

### ⚠️ Plan reconciliation — Step 5
1. **There is NO `SMH_PORT_BASE` and no env-tunable port base.** The design's port-collision mitigation
   #2 ("read a `SMH_PORT_BASE`, derive every port") does not exist — the ps1 hardcodes every base
   (4000/4001/10000/40000/8100/8080/9000/9123/5173) and computes from `-RelayCount`/`-ValidatorCount`.
   Pre-setting env before calling the script does NOT change the daemon ports (the script re-`set`s them).
   ⇒ **The pre-flight `scanCollisions` (Task 2) is the ONLY real collision-safety mechanism**; there is no
   "re-run with a different base" escape hatch without editing the ps1. Task 2's `requiredPorts` must
   enumerate the FIXED set above (all of 9000, 9123, 8080, 4000-4005, 10000-10500, 40000-40299,
   8101-8104, + chosen canary port), and any hardcoded non-overridable port that collides fails the run
   fast. `5173` only if the client is launched (it isn't).
2. **`daemons` boots the WHOLE fleet, not one relay** (contra Task 6 Step 2 "boot one relay via
   `run-rms-live-local.ps1 daemons`"). There is no single-relay sub-command; `daemons` needs `network`+`deploy`
   first (reads `dvconf-daemons\.env`). Task 6's media-fleet smoke must either run the full `daemons` stack
   or a bespoke single-relay `pnpm dev:relay` invocation with the 5 RMS env vars set.
3. **Teardown does NOT kill `sui`.** `stop` → `Stop-All` reaps only tracked `.dvconf-pids` trees and
   **intentionally leaves the Sui node on :9000 alive** (ps1 lines 20-23, 644). So the D1a→D1b re-boot
   (design requirement #3) MUST `stop` AND separately kill :9000 (and faucet :9123) — kill the listener
   on 9000 via `Get-NetTCPConnection -LocalPort 9000 | Stop-Process` (the harness owns this), then re-scan
   before re-boot. (localnet-fixture uses `taskkill /PID <pid> /T /F` for the sui tree on win32, a good
   pattern, but here the sui proc is the ps1's `Start-Process powershell` window PID saved in `.dvconf-pids`.)
4. **The daemons run from `C:\Thesis\dvconf\dvconf-daemons` (MAIN repo), reading `dvconf-daemons\.env`.**
   The harness code lives in THIS worktree (`...-smh-live\scripts\smh-live\`). Both are @ bbb715b so daemon
   behavior is identical, but env injection for D1a (`RMS_ATTESTED_PLACEMENT=1`) / D1b (unset) must target
   the MAIN repo's boot: cleanest no-code path is to append/remove `RMS_ATTESTED_PLACEMENT=1` in
   `dvconf-daemons\.env` around the D1a boot (the cp reads `process.env['RMS_ATTESTED_PLACEMENT']` and the
   daemons load `.env` via dotenv) OR add a cp-arm env pass-through in the ps1. Same channel for the
   `CANARY_CELL_SECRET` / coverage-port / `LOG_PRETTY=false` injections from Step 3.

---

## Consolidated ⚠️ items that change Tasks 2–11 (controller summary)

- **[Task 6] Export `VirtualPeer` + add `produceNew()`** (additive harness edit) OR reimplement peer from
  exported `RelayClient`. Peer produces once at join; `startAudioProducer()` is the re-invoke point.
- **[Task 2/8] No `SMH_PORT_BASE`.** Pre-flight scan is the sole collision guard; enumerate the FIXED port
  set (Step 5 table). Teardown must also kill :9000/:9123 (ps1 `stop` won't).
- **[Task 8] Boot via ps1 `network`+`deploy`+`daemons`; build `NetworkConfig` from `dvconf-daemons\.env`.**
  Do NOT use `bootLocalnet` (double-boots sui + re-publishes). Native daemons self-register — orchestrator
  drives only the USER side: `register_user` + `create_room` + **`create_escrow`** (escrow is the placement
  trigger; pattern in `scripts/load-test.ts`).
- **[Task 8/9] D1a is blocked until the coverage server is enabled:** inject `CANARY_CELL_SECRET=<hex>`
  + a non-colliding `VALIDATOR_CANARY_COVERAGE_PORT` on validator-1, point cp `RMS_LOAD_FEED_URL` at it,
  set `RMS_ATTESTED_PLACEMENT=1`. Resolve the 8102 healthz/coverage collision.
- **[Task 4/8] Force `LOG_PRETTY=false`** on cp+relay boot so `log-asserts` `JSON.parse` works
  (default JSON, but `NODE_ENV=development` from `pnpm dev:*` would flip to pino-pretty).
- **[Task 4] `readPlacementBasis` (`context.basis`) and `sawReopenRedelivery` (substring of
  `...re-delivered stored reverse announces on link reopen`) are CORRECT as planned.** Read the cp log at
  `C:\Thesis\dvconf\.logs\cp-1-*.log`; read the reopen line from `...\.logs\relay-*.log` (standby side).
- **[Task 7/11] D3 chaos precision gap:** the standby dials the PRIMARY's shared client-WS port (4000),
  not a dedicated link port, and netsh may not filter loopback. Home the during-window publisher to the
  standby; verify link `NOT-OPEN` before publishing; record the working block mechanism here once proven.
- **[Task 3] `rpc-verify` event field names:** the `RoomAssigned.relay_ids` shape is confirmed from
  `pollRoomAssignedRelays` (`rms-live-local.integration.test.ts:124-147`). The `RelayPromoted` field
  names (`old_primary`/`new_primary`/`epoch`) used by the plan's `parseRelayPromoted` were NOT
  independently verified against the Move event here (out of Step scope — grep `dvconf-contracts` +
  the relay-promoted observer at `cp-daemon/src/index.ts:~1150` at Task 3 to confirm before relying).
