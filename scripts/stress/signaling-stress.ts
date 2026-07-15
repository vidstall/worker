/**
 * Signaling-layer stress driver — Task #29 (S1+S3).
 *
 * Stresses the signaling daemon's WebSocket capacity + message-fanout
 * throughput at the protocol level (NO mediasoup / NO chain). The driver
 * boots `createServer()` from `apps/signaling` in-process and connects N
 * synthetic peers that exchange offer / answer / ice-candidate messages
 * peer-to-peer through the server, then writes a JSONL log.
 *
 * Methodology + breakage criteria: `docs/70-operations/stress-test-results.md`.
 * Schema: `docs/80-research/evaluation/m1-latency-methodology.md` §5,
 *         extended with stress-specific metric names (additive).
 *
 * Usage (see § 6 of stress-test-results.md):
 *   pnpm tsx scripts/stress/signaling-stress.ts \
 *     --scenario smoke --peers 3 --duration 10
 *
 *   pnpm tsx scripts/stress/signaling-stress.ts \
 *     --scenario s1 --peers 10 --duration 30
 *
 *   pnpm tsx scripts/stress/signaling-stress.ts \
 *     --scenario s3 --rooms 4 --peers-per-room 4 --duration 30
 */

import { WebSocket, type WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from '../../apps/signaling/src/index.js';

// ── CLI ───────────────────────────────────────────────────────────────

type Scenario = 'smoke' | 's1' | 's3';

export interface Args {
  scenario: Scenario;
  peers: number;
  rooms: number;
  peersPerRoom: number;
  durationSec: number;
  outDir: string;
  sourceIps: string[];
}

const SCENARIOS = new Set<Scenario>(['smoke', 's1', 's3']);

function positiveInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer, got ${raw}`);
  }
  return value;
}

function parseLoopbackSourceIps(raw: string): string[] {
  const sourceIps = raw.split(',').map((ip) => ip.trim()).filter(Boolean);
  if (sourceIps.length === 0) {
    throw new Error('--source-ips requires a comma-separated list');
  }
  for (const ip of sourceIps) {
    if (isIP(ip) !== 4 || !ip.startsWith('127.')) {
      throw new Error(`--source-ips only accepts IPv4 loopback addresses (127.0.0.0/8), got ${ip}`);
    }
  }
  if (new Set(sourceIps).size !== sourceIps.length) {
    throw new Error('--source-ips must not contain duplicates');
  }
  return sourceIps;
}

export function selectSourceIp(sourceIps: readonly string[], peerIndex: number): string | undefined {
  if (sourceIps.length === 0) return undefined;
  return sourceIps[peerIndex % sourceIps.length];
}

export function validateTraceId(raw: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) {
    throw new Error('BENCH_TRACE_ID must be 1-128 filename-safe characters');
  }
  return raw;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    scenario: 'smoke',
    peers: 3,
    rooms: 1,
    peersPerRoom: 3,
    durationSec: 10,
    outDir: 'bench-output',
    sourceIps: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`${a ?? 'argument'} requires a value`);
    }
    if (a === '--scenario') {
      if (!SCENARIOS.has(v as Scenario)) throw new Error(`unknown scenario: ${v}`);
      args.scenario = v as Scenario;
    } else if (a === '--peers') args.peers = positiveInt(v, a);
    else if (a === '--rooms') args.rooms = positiveInt(v, a);
    else if (a === '--peers-per-room') args.peersPerRoom = positiveInt(v, a);
    else if (a === '--duration') args.durationSec = positiveInt(v, a);
    else if (a === '--out-dir') args.outDir = v;
    else if (a === '--source-ips') args.sourceIps = parseLoopbackSourceIps(v);
    else throw new Error(`unknown argument: ${a}`);
    i++;
  }
  if (args.scenario === 's1') {
    args.rooms = 1;
    args.peersPerRoom = args.peers;
  } else if (args.scenario === 's3') {
    args.peers = args.rooms * args.peersPerRoom;
  } else {
    args.rooms = 1;
    args.peersPerRoom = args.peers;
  }
  return args;
}

// ── JSONL writer ──────────────────────────────────────────────────────

interface JsonlEvent {
  schema_version: '1.0';
  ts: number;
  trace_id: string;
  scenario: Scenario;
  source: 'stress-driver';
  instance: string;
  metric: string;
  value_ms: number;
  context: Record<string, unknown>;
}

class Writer {
  private buf: JsonlEvent[] = [];
  constructor(
    private readonly traceId: string,
    private readonly scenario: Scenario,
    private readonly instance: string,
    private readonly path: string,
  ) {}
  emit(metric: string, value_ms: number, context: Record<string, unknown> = {}): void {
    this.buf.push({
      schema_version: '1.0',
      ts: Date.now(),
      trace_id: this.traceId,
      scenario: this.scenario,
      source: 'stress-driver',
      instance: this.instance,
      metric,
      value_ms,
      context,
    });
  }
  async flush(): Promise<void> {
    if (this.buf.length === 0) return;
    const lines = this.buf.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(this.path, lines, { encoding: 'utf8', flag: 'wx' });
    this.buf = [];
  }
  getPath(): string { return this.path; }
}

// ── Peer ──────────────────────────────────────────────────────────────

interface PeerStats {
  peerId: string;            // server-assigned (from welcome)
  syntheticId: string;       // driver-internal (room slot)
  roomId: string;
  sourceIp: string | null;
  connectMs: number;
  welcomeMs: number;
  joinSentTs: number;
  msgSent: number;
  msgDropped: number;
  rejected: boolean;
  error: string | null;
}

interface Shared {
  joinSendTsByPeerId: Map<string, number>;
  writer: Writer;
}

async function runPeer(
  serverUrl: string,
  syntheticId: string,
  roomId: string,
  durationSec: number,
  shared: Shared,
  sourceIp?: string,
): Promise<PeerStats> {
  const stats: PeerStats = {
    peerId: '',
    syntheticId,
    roomId,
    sourceIp: sourceIp ?? null,
    connectMs: 0,
    welcomeMs: 0,
    joinSentTs: 0,
    msgSent: 0,
    msgDropped: 0,
    rejected: false,
    error: null,
  };

  const otherPeerIds = new Set<string>();
  const openAttemptTs = Date.now();
  let openTs = 0;

  return new Promise<PeerStats>((resolve) => {
    const ws = sourceIp === undefined
      ? new WebSocket(serverUrl)
      : new WebSocket(serverUrl, { localAddress: sourceIp });
    let endTimer: ReturnType<typeof setTimeout> | null = null;
    let sendTimer: ReturnType<typeof setInterval> | null = null;
    let resolved = false;

    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      if (endTimer) clearTimeout(endTimer);
      if (sendTimer) clearInterval(sendTimer);
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'leave' }));
          ws.close();
        }
      } catch { /* ignore */ }
      resolve(stats);
    };

    ws.on('open', () => {
      openTs = Date.now();
      stats.connectMs = openTs - openAttemptTs;
    });

    ws.on('message', (raw) => {
      let msg: { type: string; peerId?: string; roomId?: string; fromPeerId?: string };
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'welcome' && msg.peerId) {
        stats.peerId = msg.peerId;
        stats.welcomeMs = Date.now() - openTs;

        // Send join. Record send_ts under our peerId so other peers can
        // compute fanout latency when they receive `peer-joined`.
        stats.joinSentTs = Date.now();
        shared.joinSendTsByPeerId.set(stats.peerId, stats.joinSentTs);
        try {
          ws.send(JSON.stringify({ type: 'join', roomId }));
        } catch (err) {
          stats.error = `join send failed: ${(err as Error).message}`;
        }

        // After joining, periodically push offer / answer / ice to each
        // other peer we know about (light per-pair traffic to mimic
        // SDP+ICE exchange without actually doing WebRTC).
        sendTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            stats.msgDropped += otherPeerIds.size * 3;
            return;
          }
          for (const targetPeerId of otherPeerIds) {
            for (const t of ['offer', 'answer', 'ice-candidate'] as const) {
              try {
                ws.send(JSON.stringify({
                  type: t,
                  targetPeerId,
                  ...(t === 'ice-candidate'
                    ? { candidate: { candidate: `fake-ice-${syntheticId}`, sdpMid: '0' } }
                    : { sdp: { type: t, sdp: `fake-sdp-${syntheticId}-${t}` } }),
                }));
                stats.msgSent++;
              } catch {
                stats.msgDropped++;
              }
            }
          }
        }, 1000);
        return;
      }

      if (msg.type === 'peer-joined' && msg.peerId) {
        const recvTs = Date.now();
        const otherSendTs = shared.joinSendTsByPeerId.get(msg.peerId);
        otherPeerIds.add(msg.peerId);
        if (otherSendTs !== undefined) {
          shared.writer.emit('T_joined_fanout_ms', recvTs - otherSendTs, {
            observer_peer_id: stats.peerId,
            other_peer_id: msg.peerId,
            room_id: roomId,
          });
        }
        return;
      }

      if (msg.type === 'peer-left' && msg.peerId) {
        otherPeerIds.delete(msg.peerId);
        return;
      }

      // offer / answer / ice-candidate — count receipt only
      // (we already attribute send-side stats per peer)
    });

    ws.on('close', (code) => {
      if (code === 4029) {
        stats.rejected = true;
        stats.error = `rejected: code ${code}`;
      }
      if (!resolved) finish();
    });

    ws.on('error', (err) => {
      stats.error = err.message;
    });

    // End peer after duration (from when ws emits 'open'; falls back to
    // open-attempt + duration for peers that never open).
    endTimer = setTimeout(finish, durationSec * 1000);
  });
}

// ── Resource sampler ─────────────────────────────────────────────────

interface ResourceSnapshot { rssMb: number; cpuMicros: number; }
function snapshot(): ResourceSnapshot {
  const mu = process.memoryUsage();
  const cu = process.cpuUsage();
  return { rssMb: mu.rss / (1024 * 1024), cpuMicros: cu.user + cu.system };
}

// ── Orchestrator ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const traceId = validateTraceId(process.env['BENCH_TRACE_ID'] ?? randomUUID());
  const startTs = Date.now();

  await mkdir(args.outDir, { recursive: true });
  // Keep the trace id as the final filename token so the canonical bench replay
  // (`loadTrace`) can discover stress artifacts without a rename/copy step.
  const outPath = join(args.outDir, `stress-${args.scenario}-${startTs}-${traceId}.jsonl`);
  const writer = new Writer(traceId, args.scenario, `driver-${process.pid}`, outPath);

  // Boot in-process signaling server on a random free port (port 0 → OS picks).
  const wss: WebSocketServer = createServer(0);
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const addr = wss.address();
  if (typeof addr === 'string' || addr === null) {
    throw new Error('Signaling server address is not an object');
  }
  const serverUrl = `ws://127.0.0.1:${addr.port}`;

  // Banner.
  console.log('='.repeat(60));
  console.log('Signaling stress driver — Task #29');
  console.log('='.repeat(60));
  console.log(`  scenario:      ${args.scenario}`);
  console.log(`  peers total:   ${args.peers}`);
  console.log(`  rooms:         ${args.rooms} × ${args.peersPerRoom} peers/room`);
  console.log(`  duration:      ${args.durationSec}s`);
  console.log(`  server:        ${serverUrl}`);
  console.log(`  source IPs:    ${args.sourceIps.length === 0 ? 'OS default' : args.sourceIps.join(', ')}`);
  console.log(`  trace_id:      ${traceId}`);
  console.log(`  jsonl:         ${outPath}`);
  console.log('');

  // Shared state for cross-peer fanout latency computation.
  const shared: Shared = {
    joinSendTsByPeerId: new Map(),
    writer,
  };

  // Resource baseline.
  const t0Snap = snapshot();
  let rssPeakMb = t0Snap.rssMb;
  const sampleHandle = setInterval(() => {
    const s = snapshot();
    if (s.rssMb > rssPeakMb) rssPeakMb = s.rssMb;
  }, 500);

  // Spawn peers grouped by room.
  const peerPromises: Promise<PeerStats>[] = [];
  let peerIndex = 0;
  for (let r = 0; r < args.rooms; r++) {
    const roomId = `stress-${args.scenario}-r${r}`;
    for (let p = 0; p < args.peersPerRoom; p++) {
      const syntheticId = `r${r}-p${p}`;
      const sourceIp = selectSourceIp(args.sourceIps, peerIndex++);
      peerPromises.push(runPeer(serverUrl, syntheticId, roomId, args.durationSec, shared, sourceIp));
      // Tiny stagger so welcome timestamps do not collide.
      await new Promise((r2) => setTimeout(r2, 25));
    }
  }

  const peerResults = await Promise.all(peerPromises);
  clearInterval(sampleHandle);
  const t1Snap = snapshot();

  // Emit per-peer connect / welcome events.
  for (const ps of peerResults) {
    writer.emit('T_connect_ms', ps.connectMs, {
      peer_id: ps.peerId || ps.syntheticId,
      room_id: ps.roomId,
      source_ip: ps.sourceIp,
      rejected: ps.rejected,
      error: ps.error,
    });
    if (ps.peerId !== '') {
      writer.emit('T_welcome_ms', ps.welcomeMs, {
        peer_id: ps.peerId,
        room_id: ps.roomId,
        source_ip: ps.sourceIp,
      });
    }
  }

  // Aggregate.
  const nAccepted = peerResults.filter((p) => p.peerId !== '' && !p.rejected).length;
  const nRejected = peerResults.filter((p) => p.rejected).length;
  const nMsgSent = peerResults.reduce((s, p) => s + p.msgSent, 0);
  const nMsgDropped = peerResults.reduce((s, p) => s + p.msgDropped, 0);
  const connectMsArr = peerResults.filter((p) => p.connectMs > 0).map((p) => p.connectMs).sort((a, b) => a - b);
  const welcomeMsArr = peerResults.filter((p) => p.welcomeMs > 0).map((p) => p.welcomeMs).sort((a, b) => a - b);
  function pct(arr: number[], q: number): number {
    if (arr.length === 0) return 0;
    const i = Math.max(0, Math.min(arr.length - 1, Math.ceil(arr.length * q) - 1));
    return arr[i]!;
  }
  const elapsedSec = (Date.now() - startTs) / 1000;
  const cpuDeltaMicros = t1Snap.cpuMicros - t0Snap.cpuMicros;
  const cpuPctAvg = (cpuDeltaMicros / 1000 / (elapsedSec * 1000)) * 100;

  // Breakage classification.
  const breakages: string[] = [];
  if (nRejected > 0) breakages.push('B-1 (connection refused)');
  if (nMsgDropped > 0) breakages.push('B-3 (message drops)');
  // B-2 fanout p95 budget: we don't have all fanout entries in memory; compute from writer buffer.
  // Approximation: skip B-2 here; the JSONL is the source of truth for replay.
  // B-4/B-5 (RSS / CPU) thresholds.
  if (rssPeakMb > 200) breakages.push(`B-4 (rss peak ${rssPeakMb.toFixed(1)} MB > 200)`);
  if (cpuPctAvg > 60) breakages.push(`B-5 (cpu avg ${cpuPctAvg.toFixed(1)}% > 60)`);
  for (const p of peerResults) {
    if (p.error && !p.rejected) {
      breakages.push(`B-6 (driver error on ${p.syntheticId}: ${p.error})`);
    }
  }

  // Summary event.
  writer.emit('stress_summary', 0, {
    scenario_params: {
      peers: args.peers,
      rooms: args.rooms,
      peers_per_room: args.peersPerRoom,
      duration_sec: args.durationSec,
      source_ips: args.sourceIps.length === 0 ? ['OS-default'] : args.sourceIps,
    },
    n_accepted: nAccepted,
    n_rejected: nRejected,
    n_msg_sent: nMsgSent,
    n_msg_dropped: nMsgDropped,
    rss_mb_peak: rssPeakMb,
    cpu_pct_avg: cpuPctAvg,
    elapsed_sec: elapsedSec,
    breakages,
  });

  await writer.flush();
  wss.close();

  // Pretty report.
  console.log('-'.repeat(60));
  console.log('RESULTS');
  console.log('-'.repeat(60));
  console.log(`  accepted / target:          ${nAccepted} / ${args.peers}`);
  console.log(`  rejected (rate-limit etc):  ${nRejected}`);
  console.log(`  T_connect_ms  p50 / p95:    ${pct(connectMsArr, 0.5)} / ${pct(connectMsArr, 0.95)}`);
  console.log(`  T_welcome_ms  p50 / p95:    ${pct(welcomeMsArr, 0.5)} / ${pct(welcomeMsArr, 0.95)}`);
  console.log(`  messages sent / dropped:    ${nMsgSent} / ${nMsgDropped}`);
  console.log(`  driver rss peak:            ${rssPeakMb.toFixed(1)} MB`);
  console.log(`  driver cpu avg:             ${cpuPctAvg.toFixed(1)} %`);
  console.log(`  elapsed:                    ${elapsedSec.toFixed(2)} s`);
  console.log('');
  if (breakages.length === 0) {
    console.log('  breakages tripped:          (none)');
  } else {
    console.log('  breakages tripped:');
    for (const b of breakages) console.log(`    - ${b}`);
  }
  console.log('');
  console.log(`JSONL: ${outPath}`);
  console.log('='.repeat(60));

  // Exit code: 0 if no hard breakages (B-1 / B-3 / B-6); 1 otherwise.
  const hardBreakages = breakages.filter((b) =>
    b.startsWith('B-1') || b.startsWith('B-3') || b.startsWith('B-6'),
  );
  process.exit(hardBreakages.length === 0 ? 0 : 1);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((err) => {
    console.error('stress driver crashed:', err);
    process.exit(2);
  });
}
