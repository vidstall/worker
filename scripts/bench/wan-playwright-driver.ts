// wan-playwright-driver.ts
import { chromium, type BrowserContext, type Page } from 'playwright';

interface DriverOpts {
  sessions: number; pageBase: string; relay: string; bench: string; realCamera: boolean; holdMs: number; e2ee: string;
}

function parse(argv: string[]): DriverOpts {
  const g = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d; };
  return {
    sessions: parseInt(g('sessions', '30'), 10),
    pageBase: g('page', 'http://localhost:5173/bench/wan-measure-page.html'),
    relay: g('relay', 'ws://localhost:4000'),
    bench: g('bench', 'http://localhost:8081'),
    realCamera: argv.includes('--real-camera'),
    holdMs: parseInt(g('hold-ms', '20000'), 10), // ~20 samples/session at 1 Hz
    e2ee: g('e2ee', 'off'), // P2: 'on' attaches the SFrame transform to both legs (glass-to-glass ON-vs-OFF)
  };
}

async function runSession(o: DriverOpts, i: number): Promise<void> {
  const trace = `wan-${i}`;
  const room = `wan-${i}`;
  const flags = o.realCamera ? [] : ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
  const browser = await chromium.launch({ args: flags });
  const mk = async (role: string): Promise<{ ctx: BrowserContext; page: Page }> => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const u = new URL(o.pageBase);
    u.searchParams.set('role', role); u.searchParams.set('trace', trace);
    u.searchParams.set('room', room); u.searchParams.set('relay', o.relay);
    u.searchParams.set('bench', o.bench); u.searchParams.set('peer', `${role}-${i}`);
    if (o.realCamera) u.searchParams.set('camera', 'real');
    u.searchParams.set('e2ee', o.e2ee); // P2: both legs get the same flag (ON-vs-OFF glass-to-glass)
    await page.goto(u.toString());
    return { ctx, page };
  };
  const producer = await mk('produce');
  // T2-2: launch the consumer only AFTER produce() has resolved on the producer page
  // (window.__wanProducerReady) instead of a fixed 500 ms — otherwise consumeRemote's <=30s
  // newProducer wait lands inside the consumer's join-to-first-frame t0->t1 and pollutes the metric.
  await producer.page.waitForFunction(
    () => (window as unknown as { __wanProducerReady?: boolean }).__wanProducerReady === true,
    { timeout: 30000 },
  );
  const consumer = await mk('consume');
  await new Promise((r) => setTimeout(r, o.holdMs));
  await producer.ctx.close(); await consumer.ctx.close(); await browser.close();
  console.log(`session ${i + 1}/${o.sessions} done (trace=${trace})`);
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2));
  for (let i = 0; i < o.sessions; i++) await runSession(o, i); // sequential = independent sessions (REQ-WLM-05)
  // B2: all sessions pool into the ONE signaling JSONL (BENCH_TRACE_ID); separable by context.room_id (=wan-<i>).
  console.log(`\nAll ${o.sessions} sessions complete. Assemble the run trace with join-g2g.ts -> one row per context.room_id + per-session p95.`);
}
void main();
