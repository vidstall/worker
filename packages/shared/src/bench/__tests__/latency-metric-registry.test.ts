import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LatencyWriter } from '../writer.js';

describe('LatencyMetric registry', () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

  it('accepts the new WAN-measurement metrics and round-trips them to JSONL', () => {
    dir = mkdtempSync(join(tmpdir(), 'lat-'));
    const w = new LatencyWriter({ source: 'client', instance: 'peerA', outputDir: dir, scenario: 's-wan', traceId: 't1' });
    // Each of these is a tsc error until the enum is extended (write() binds LatencyEvent['metric']).
    w.write('L_encode', 8.1, { flow_id: 'p1' });
    w.write('L_jitterbuffer', 22.4, { flow_id: 'p1' });
    w.write('L_decode', 4.3, { flow_id: 'p1' });
    w.write('L_present', 9.0, { flow_id: 'p1' });
    w.write('L_rtt_send', 31.0, { flow_id: 'p1' });
    w.write('L_rtt_recv', 28.0, { flow_id: 'p1' });
    w.write('L_g2g_optB_full', 120.5, { flow_id: 'p1' });
    w.write('t_hop_network', 15.2, { leg: 'inter-relay' });
    w.write('L_g2g_RTT_proxy', 65.0, { flow_id: 'p1' });
    w.close();

    const metrics = readFileSync(w.getFilePath(), 'utf8')
      .split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { metric: string }).metric);
    expect(metrics).toEqual([
      'L_encode', 'L_jitterbuffer', 'L_decode', 'L_present',
      'L_rtt_send', 'L_rtt_recv', 'L_g2g_optB_full', 't_hop_network', 'L_g2g_RTT_proxy',
    ]);
  });
});
