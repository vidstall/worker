import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateK2Session,
  parseK2Evidence,
  renderK2Aggregate,
  validateK2ProofRows,
  type EvidenceRow,
} from '../cost-k2-evidence.ts';
import { parseCostRunOptions, writeTextExclusive } from '../cost-run-safety.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function gas(computation: number, storage = 5, rebate = 1, nonRefundable = 2) {
  return {
    computationCost: String(computation),
    storageCost: String(storage),
    storageRebate: String(rebate),
    nonRefundableStorageFee: String(nonRefundable),
  };
}

function row(fn: string, index: number, computation = 100): EvidenceRow {
  return {
    fn,
    module: fn === 'close_room' || fn === 'create_room' || fn === 'submit_pairing_proposal'
      ? 'room_manager'
      : 'economic_layer',
    gasUsed: gas(computation, 20, 5, 1),
    digest: `digest-${index}`,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
  };
}

function completeRows(): EvidenceRow[] {
  const rows: EvidenceRow[] = [
    row('create_room', 0),
    row('create_escrow', 1),
    row('submit_pairing_proposal', 2),
  ];
  let ordinal = 0;
  for (let validatorIndex = 0; validatorIndex < 4; validatorIndex += 1) {
    for (let relaySlot = 0; relaySlot < 2; relaySlot += 1) {
      ordinal += 1;
      rows.push({
        ...row('submit_session_proof', ordinal + 2, 9 + ordinal),
        context: {
          validator_index: validatorIndex,
          relay_slot: relaySlot,
          relay_miner_id: `relay-${relaySlot}`,
          proof_ordinal: ordinal,
          K: 2,
          N: 4,
        },
      });
    }
  }
  rows.push(row('close_room', 20), row('distribute_rewards', 21));
  return rows;
}

describe('K=2/N=4 cost evidence', () => {
  it('requires every validator/relay pair and sums the actual eight proof rows', () => {
    const aggregate = aggregateK2Session(completeRows());
    expect(aggregate.proofRows).toHaveLength(8);
    expect(aggregate.proofTotals.computation).toBe(108n);
    expect(aggregate.proofTotals.irreversible).toBe(116n);
    expect(aggregate.proofTotals.net).toBe(228n);
    expect(aggregate.sessionTotals.transactionCount).toBe(13);
    expect(aggregate.sessionTotals.computation).toBe(608n);
    expect(aggregate.sessionTotals.irreversible).toBe(621n);
    expect(aggregate.sessionTotals.net).toBe(803n);
  });

  it('rejects a duplicated validator/relay pair even when eight rows exist', () => {
    const rows = completeRows();
    const proofs = rows.filter((candidate) => candidate.fn === 'submit_session_proof');
    proofs[7]!.context = proofs[0]!.context;
    expect(() => validateK2ProofRows(rows)).toThrow(/duplicate validator\/relay proof pair/);
  });

  it('rejects distribution recorded before the complete proof state', () => {
    const rows = completeRows();
    const distributionIndex = rows.findIndex((candidate) => candidate.fn === 'distribute_rewards');
    const [distribution] = rows.splice(distributionIndex, 1);
    rows.splice(3, 0, distribution!);
    expect(() => aggregateK2Session(rows)).toThrow(/row order/);
  });

  it('parses complete provenance and renders computation, irreversible, and net totals', () => {
    const meta = {
      meta: true,
      complete: true,
      K: 2,
      N: 4,
      runId: 'test-run',
      protocolVersion: '113',
      referenceGasPrice: '1000',
      frameworkRev: 'framework',
      contractCommit: 'contract',
      daemonCommit: 'daemon',
    };
    const raw = `${[meta, ...completeRows()].map((value) => JSON.stringify(value)).join('\n')}\n`;
    const parsed = parseK2Evidence(raw);
    const rendered = renderK2Aggregate(parsed, aggregateK2Session(parsed.rows), 'raw.jsonl');
    expect(rendered).toContain('proofs (actual K×N)');
    expect(rendered).toContain('full session K=2/N=4');
    expect(rendered).toContain('| full session K=2/N=4 | 13 | 608 | 621 | 803 |');
  });
});

describe('cost run safety', () => {
  it('requires an isolated contracts snapshot and derives a new output path', () => {
    const root = mkdtempSync(join(tmpdir(), 'dvconf-cost-test-'));
    tempDirs.push(root);
    const snapshot = join(root, 'snapshot');
    mkdirSync(snapshot);
    writeFileSync(join(snapshot, 'Move.toml'), '[package]\nname = "x"\n');
    writeFileSync(join(snapshot, 'Move.lock'), '[pinned.local.Sui]\nsource = { rev = "94ad8ccd" }\n');
    const options = parseCostRunOptions(
      ['--contracts-dir', snapshot, '--run-id', 'unit'],
      root,
      new Date('2026-07-15T00:00:00.000Z'),
    );
    expect(options.outputPath).toContain('cost-onchain-localnet-k2-n4-2026-07-15-unit.jsonl');
    expect(options.contractsDir).toBe(snapshot);
  });

  it('writes evidence once and fails closed on the second write', () => {
    const root = mkdtempSync(join(tmpdir(), 'dvconf-cost-write-'));
    tempDirs.push(root);
    const output = join(root, 'evidence.jsonl');
    writeTextExclusive(output, 'first\n');
    expect(() => writeTextExclusive(output, 'second\n')).toThrow();
  });
});
