import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  loadTranscript,
  parseTranscript,
  reportSlashes,
  reportProofs,
  reportRelayHistory,
  reportRewards,
  QUORUM_REQUIRED,
} from '../report.js';
import { suiEventToForensicLine } from '../collect.js';
import type { SuiEvent } from '@mysten/sui/client';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, '../../fixtures/smoke-events.jsonl');

describe('forensic-cli report stage', () => {
  it('parses the synthetic fixture without error', async () => {
    const events = await loadTranscript(FIXTURE);
    expect(events).toHaveLength(12);
    for (const e of events) expect(e.schema).toBe('forensic-cli/1.0');
  });

  it('C-SLASH: surfaces exactly one slash row', async () => {
    const events = await loadTranscript(FIXTURE);
    const rows = reportSlashes(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relay_miner_id).toBe('0xRELAY1');
    expect(rows[0]?.slash_amount).toBe('500000000');
  });

  it('C-PROOF: flags insufficient_quorum when <ADR-0006 quorum', async () => {
    const events = await loadTranscript(FIXTURE);
    const report = reportProofs(events, '0xROOM1');
    expect(report.rows).toHaveLength(2);
    expect(report.unique_validators).toBe(2);
    expect(report.quorum_required).toBe(QUORUM_REQUIRED);
    expect(report.insufficient_quorum).toBe(true);
  });

  it('C-PROOF: computes median of bytes_transferred and packet_loss_bps', async () => {
    const events = await loadTranscript(FIXTURE);
    const report = reportProofs(events, '0xROOM1');
    // (1_048_576 + 1_100_000) / 2 = 1_074_288
    expect(report.median_bytes_transferred).toBe('1074288');
    // (50 + 80) / 2 = 65
    expect(report.median_packet_loss_bps).toBe('65');
  });

  it('C-PROOF: returns empty for unknown room', async () => {
    const events = await loadTranscript(FIXTURE);
    const report = reportProofs(events, '0xUNKNOWN');
    expect(report.rows).toHaveLength(0);
    expect(report.unique_validators).toBe(0);
    expect(report.insufficient_quorum).toBe(true);
    expect(report.median_bytes_transferred).toBeNull();
  });

  it('C-RELAY: timeline is chronological + flags registered+slashed+degraded', async () => {
    const events = await loadTranscript(FIXTURE);
    const report = reportRelayHistory(events, '0xRELAY1');
    expect(report.timeline).toHaveLength(7);
    expect(report.registered).toBe(true);
    expect(report.slashed).toBe(true);
    expect(report.performance_degraded_count).toBe(1);
    // First event must be RelayRegistered, last must be RelaySlashed
    expect(report.timeline[0]?.event).toBe('RelayRegistered');
    expect(report.timeline[report.timeline.length - 1]?.event).toBe('RelaySlashed');
  });

  it('C-RELAY: empty timeline for unknown miner', async () => {
    const events = await loadTranscript(FIXTURE);
    const report = reportRelayHistory(events, '0xUNKNOWN');
    expect(report.timeline).toHaveLength(0);
    expect(report.registered).toBe(false);
    expect(report.slashed).toBe(false);
  });

  it('C-REWARD: surfaces row + computes totals', async () => {
    const events = await loadTranscript(FIXTURE);
    const report = reportRewards(events);
    expect(report.rows).toHaveLength(1);
    expect(report.any_mismatch).toBe(false);
    // 700M + 100M + 50M + 50M = 900M
    expect(report.total_distributed).toBe('900000000');
    expect(report.total_remainder).toBe('100000000');
    // total = 1B
    expect(report.rows[0]?.total).toBe('1000000000');
  });

  it('C-REWARD: filters by room_id', async () => {
    const events = await loadTranscript(FIXTURE);
    const matched = reportRewards(events, '0xROOM1');
    const empty = reportRewards(events, '0xELSEWHERE');
    expect(matched.rows).toHaveLength(1);
    expect(empty.rows).toHaveLength(0);
  });

  it('parseTranscript rejects unknown schema versions', () => {
    const bad = '{"schema":"forensic-cli/2.0","ts":"","tx":"","seq":"","module":"","event":"","payload":{}}';
    expect(() => parseTranscript(bad)).toThrow(/Unsupported forensic schema/);
  });
});

describe('forensic-cli collect stage', () => {
  it('suiEventToForensicLine normalizes a SuiEvent', () => {
    const ev: SuiEvent = {
      id: { txDigest: '0xdeadbeef', eventSeq: '3' },
      packageId: '0xPKG',
      transactionModule: 'economic_layer',
      sender: '0xS',
      type: '0xPKG::economic_layer::RelaySlashed',
      parsedJson: { room_id: '0xR', relay_miner_id: '0xRELAY', slash_amount: '42' },
      bcs: '',
      timestampMs: '1747396800000', // 2025-05-16T12:00:00Z
    } as SuiEvent;

    const line = suiEventToForensicLine(ev);
    expect(line.schema).toBe('forensic-cli/1.0');
    expect(line.tx).toBe('0xdeadbeef');
    expect(line.seq).toBe('3');
    expect(line.module).toBe('economic_layer');
    expect(line.event).toBe('RelaySlashed');
    expect(line.payload['relay_miner_id']).toBe('0xRELAY');
    expect(line.ts).toMatch(/^2025-05-16T/);
  });
});
