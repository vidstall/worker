/**
 * Node mediasoup-client bench harness — S23.2.C1.
 *
 * Spawns 2 virtual peers that join a relay room, produce a silent audio track,
 * consume each other's audio, and poll `Consumer.getStats()` every 1 s to
 * compute and emit `L_g2g_optB` per methodology §3.2:
 *
 *   L_g2g_optB = currentRoundTripTime/2 + jitterBufferDelay
 *              + capture/encode/render constant (50 ms)
 *
 * The harness lets us measure end-to-end latency through the real relay path
 * from a Node process — the `dvconf-client` browser app uses raw
 * `RTCPeerConnection` rather than `mediasoup-client` so it cannot exercise the
 * relay-mediated path the methodology defines.
 *
 * Module layout:
 *
 *   ── Pure helpers (vitest-covered) ──
 *   - `computeG2GoptB(stats)` — methodology §3.2 arithmetic (`mediasoup/stats.ts`)
 *   - `extractRelevantStats(report)` — pluck rtt + jitterBufferDelay from RTCStats (`mediasoup/stats.ts`)
 *   - `startConsumerPoller(consumer, writer, context)` — 1 Hz sampler (`mediasoup/consumer-poller.ts`)
 *   - `parseArgs(argv)` — CLI: --relay-url --room-id --duration (`mediasoup/cli-args.ts`)
 *
 *   ── Relay protocol client (vitest-covered with mocked WS) ──
 *   - `RelayClient` — ws + JSON request/response over the protocol defined in
 *     `apps/relay/src/signaling.ts` (`join` → `routerRtpCapabilities`,
 *     `createTransport` → `transportCreated`, `produce` → `produced`,
 *     `consume` → `consumed`, push `newProducer`)
 *
 *   ── Integration (validated end-to-end in S23.3) ──
 *   - `VirtualPeer` — wires `RelayClient` + `mediasoup-client.Device` +
 *     `@roamhq/wrtc.nonstandard.RTCAudioSource` + `startConsumerPoller`
 *     (`mediasoup/relay-client.ts`)
 *
 * Plan: `docs/80-research/evaluation/s23-plan.md` § S23.2.C1
 * Methodology: `docs/80-research/evaluation/m1-latency-methodology.md` §3.2
 */

// Scripts live outside any workspace package, so `@dvconf/shared` is not
// resolvable from this directory's node_modules. Reach into the source tree
// directly — tsx resolves `.js` extension to `.ts`. Pattern mirrors how
// `scripts/load-test.ts` and `scripts/smoke-test.ts` historically reached
// shared utilities; the imports there are type-only so the gap is hidden.
import { LatencyWriter, isBenchEnabled } from '../../packages/shared/src/index.js';

export {
  CAPTURE_ENCODE_RENDER_MS,
  computeG2GoptB,
  extractRelevantStats,
  extractRttOnly,
  extractBytesReceived,
  type RelevantStats,
  type StatsReportLike,
} from './mediasoup/stats.ts';

export {
  startConsumerPoller,
  type ConsumerLike,
  type TransportLike,
  type WriterLike,
  type ConsumerPollerOpts,
} from './mediasoup/consumer-poller.ts';

export {
  DEFAULT_STUN_URL,
  buildIceServers,
  parseArgs,
  peerLabel,
  type IceMode,
  type CliArgs,
  type BuildIceServersOpts,
} from './mediasoup/cli-args.ts';

export { retryOnTimeout, VirtualPeer, type VirtualPeerOptions } from './mediasoup/relay-client.ts';

import { buildIceServers, parseArgs, peerLabel } from './mediasoup/cli-args.ts';
import { VirtualPeer } from './mediasoup/relay-client.ts';

// ── CLI entry ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!isBenchEnabled()) {
    console.error('BENCH_LATENCY=1 required to write JSONL events.');
    process.exit(1);
  }
  const args = parseArgs(process.argv);
  const iceServers = buildIceServers(args.iceMode, {
    turnUrl: process.env['BENCH_TURN_URL'],
    turnUsername: process.env['BENCH_TURN_USERNAME'],
    turnCredential: process.env['BENCH_TURN_CREDENTIAL'],
  });
  console.log(
    `[harness] relay=${args.relayUrl} room=${args.roomId} peers=${args.peers} duration=${args.durationMs}ms ice-mode=${args.iceMode} (${iceServers.length} ice-server${iceServers.length === 1 ? '' : 's'})`,
  );

  const writer = new LatencyWriter({
    source: 'client',
    instance: 'harness',
  });
  console.log(`[harness] writing to ${writer.getFilePath()}`);

  const peers: VirtualPeer[] = [];
  for (let i = 0; i < args.peers; i++) {
    peers.push(
      new VirtualPeer({
        relayUrl: args.relayUrl,
        roomId: args.roomId,
        peerId: `harness-peer-${peerLabel(i)}`,
        writer,
        iceServers,
      }),
    );
  }
  // Sequential join — relay's per-room async lock (added at S25.C-followup.D
  // in apps/relay/src/signaling.ts) removes the CI-18 parallel-join race.
  // We keep sequential setup here to make per-peer log lines deterministic
  // and easier to triage if something regresses; no inter-peer delay needed.
  for (let i = 0; i < peers.length; i++) {
    await peers[i]!.run();
  }
  console.log(`[harness] ${peers.length} peers joined, sampling…`);

  await new Promise((r) => setTimeout(r, args.durationMs));

  // Flush JSONL before the wrtc cleanup chain — LatencyWriter.close() does
  // a final writeSync + fsync, must complete before we exit.
  writer.close();
  console.log('[harness] done');

  // CI-19 mitigation: @roamhq/wrtc's native binding teardown crashes Node
  // on Windows with STATUS_STACK_BUFFER_OVERRUN (0xC0000409) when
  // Producer/Consumer/Transport close() chains fire during the same exit
  // (G-016). Data layer is already flushed above. Skip the JS-level close
  // chain and SIGKILL ourselves so the native cleanup doesn't run.
  // Disclosure: this trades exit-code cleanliness for stable data emission;
  // ch5 §5.2.7 documents the trade-off. Real fix (upstream binding swap)
  // tracked separately.
  process.kill(process.pid, 'SIGKILL');
}

const isMain =
  process.argv[1]?.endsWith('mediasoup-client-harness.ts') === true ||
  process.argv[1]?.endsWith('mediasoup-client-harness.js') === true;

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
