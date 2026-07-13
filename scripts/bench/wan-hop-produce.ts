// wan-hop-produce.ts — Lane-B cross-relay two-peer driver (t_hop_network).
//
// Drives the FAITHFUL shipped forwarding path across two relay HOSTS so the
// standby's inter-relay pipe carries real RTP and its latency-probe (T7,
// BENCH_LATENCY=1) samples the inter-relay RTCP roundTripTime → t_hop_network
// rows in relay-B's apps/relay/bench-output/adhoc-relay-<RUN_ID>.jsonl.
//
// WHY TWO PEERS ON TWO RELAYS: the standby only active-forwards once a client
// TOUCHES it — onStandbyRoomReady fires on the FIRST PEER JOIN to the standby
// (signaling.ts:1203; index.ts:1084 "paused warm pipe opened on first peer
// join"). A lone producer on the primary leaves the standby idle (proven: the
// crossrelay liveproof's 2nd standby "stayed idle, no client touched it →
// onStandbyRoomReady never fired"). So:
//   producer → relay-A (PRIMARY)  — publishes media
//   consumer → relay-B (STANDBY)  — joins (opens warm pipe) + consumes the
//                                   forwarded producer (pulls it across the
//                                   inter-relay pipe → real RTP → T7 samples)
// This is exactly the proven "browser-consume-via-standby" (Stage B) leg.
import { chromium, type BrowserContext } from 'playwright';

interface Opts {
  page: string; relayA: string; relayB: string; room: string; bench: string; holdMs: number; realCamera: boolean;
}

function parse(argv: string[]): Opts {
  const g = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d; };
  return {
    page: g('page', 'http://localhost:5173/bench/wan-measure-page.html'),
    relayA: g('relay-a', 'ws://localhost:4000'),   // PRIMARY (producer target)
    relayB: g('relay-b', 'ws://localhost:4000'),   // STANDBY (consumer target)
    room: g('room', 'wan-measure'),
    bench: g('bench', 'http://localhost:8081'),
    holdMs: parseInt(g('hold-ms', '60000'), 10),
    realCamera: argv.includes('--real-camera'),
  };
}

// The send-stats collector POSTs to the bench sink cross-origin (CORS-blocked
// from localhost:5173 → VM:8081); those failures are harmless for Lane-B
// (t_hop is measured relay-side, not from the browser) — filter the spam so the
// operator sees only produce/consume/fatal lines.
function wantLog(t: string): boolean {
  return !/bench|CORS|Failed to fetch|ERR_FAILED|Access to fetch/i.test(t);
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2));
  const flags = o.realCamera ? [] : ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
  const browser = await chromium.launch({ args: flags });

  const mk = async (role: 'produce' | 'consume', relay: string, peer: string): Promise<BrowserContext> => {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    pg.on('console', (m) => { const t = m.text(); if (wantLog(t)) console.log(`[${peer}] ${t}`); });
    pg.on('pageerror', (e) => console.log(`[${peer}] PAGEERROR ${e.message}`));
    const u = new URL(o.page);
    u.searchParams.set('role', role);
    u.searchParams.set('trace', o.room);
    u.searchParams.set('room', o.room);
    u.searchParams.set('relay', relay);
    u.searchParams.set('bench', o.bench);
    u.searchParams.set('peer', peer);
    if (o.realCamera) u.searchParams.set('camera', 'real');
    await pg.goto(u.toString());
    return ctx;
  };

  console.log(`[wan-hop] room=${o.room}`);
  console.log(`[wan-hop] consumer → relay-B (standby) ${o.relayB}`);
  console.log(`[wan-hop] producer → relay-A (primary) ${o.relayA}`);
  // ORDER MATTERS: consumer joins the STANDBY *first* so onStandbyRoomReady fires
  // and the per-(room) warm pipe + cascade-peer registration completes on the
  // primary BEFORE any produce. The primary announces PIPED ids AT PRODUCE TIME
  // (cascadePeers snapshot) and does NOT re-announce an already-created producer
  // to a standby that connects later — so producer-first yields cascadePeers:0
  // and the standby never mints (observed in this harness's live runs). Consumer-first → the
  // produce sees cascadePeers:1 → standby mints → RTP crosses the pipe → T7.
  const consumer = await mk('consume', o.relayB, 'hop-consumer');
  await new Promise((r) => setTimeout(r, 5000)); // let the warm-pipe handshake settle
  const producer = await mk('produce', o.relayA, 'hop-producer');
  console.log(`[wan-hop] holding ${o.holdMs}ms for RTP + RTCP RR (t_hop) samples…`);
  await new Promise((r) => setTimeout(r, o.holdMs));
  await consumer.close(); await producer.close(); await browser.close();
  console.log(`[wan-hop] done (room=${o.room}) — collect relay-B t_hop JSONL now`);
}
void main();
