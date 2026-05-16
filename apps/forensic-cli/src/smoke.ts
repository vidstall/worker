/**
 * Forensic CLI — offline smoke runner.
 *
 * Loads the synthetic fixture, runs all 4 report subcommands, asserts the
 * expected shape, and prints a one-line summary. Used for `pnpm forensic:smoke`
 * to validate that the CLI is wired correctly without needing a live chain.
 *
 * Spec: docs/70-operations/forensic-cli.md § 8.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  loadTranscript,
  reportSlashes,
  reportProofs,
  reportRelayHistory,
  reportRewards,
  QUORUM_REQUIRED,
} from './report.js';

const FIXTURE_ROOM_ID = '0xROOM1';
const FIXTURE_MINER_ID = '0xRELAY1';

export async function runSmoke(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturePath = resolve(here, '../fixtures/smoke-events.jsonl');

  const events = await loadTranscript(fixturePath);

  const slashes = reportSlashes(events);
  const proofs = reportProofs(events, FIXTURE_ROOM_ID);
  const relayHist = reportRelayHistory(events, FIXTURE_MINER_ID);
  const rewards = reportRewards(events);

  // Assertions matching the documented expectations in forensic-cli.md § 8.
  if (slashes.length !== 1) {
    throw new Error(`smoke: expected 1 slash, got ${slashes.length}`);
  }
  if (proofs.rows.length !== 2) {
    throw new Error(`smoke: expected 2 proofs for ${FIXTURE_ROOM_ID}, got ${proofs.rows.length}`);
  }
  if (!proofs.insufficient_quorum) {
    throw new Error(`smoke: expected insufficient_quorum (2 < ${QUORUM_REQUIRED}), got false`);
  }
  if (relayHist.timeline.length !== 7) {
    throw new Error(`smoke: expected 7-entry relay timeline for ${FIXTURE_MINER_ID}, got ${relayHist.timeline.length}`);
  }
  if (!relayHist.registered || !relayHist.slashed) {
    throw new Error('smoke: relay history missing registered or slashed flag');
  }
  if (rewards.rows.length !== 1 || rewards.any_mismatch) {
    throw new Error(`smoke: expected 1 reward row, no mismatch — got ${rewards.rows.length}, mismatch=${rewards.any_mismatch}`);
  }

  const summary = {
    schema: 'forensic-cli/1.0',
    fixture_events: events.length,
    c_slash_count: slashes.length,
    c_proof: {
      rows: proofs.rows.length,
      unique_validators: proofs.unique_validators,
      quorum_required: proofs.quorum_required,
      insufficient_quorum: proofs.insufficient_quorum,
    },
    c_relay_history: {
      timeline_entries: relayHist.timeline.length,
      registered: relayHist.registered,
      slashed: relayHist.slashed,
      performance_degraded_count: relayHist.performance_degraded_count,
    },
    c_reward: {
      rows: rewards.rows.length,
      total_distributed: rewards.total_distributed,
      total_remainder: rewards.total_remainder,
      any_mismatch: rewards.any_mismatch,
    },
    smoke: 'ok',
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}
