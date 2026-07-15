import { sha256Text } from './cost-run-safety.ts';

export interface GasUsed {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
  nonRefundableStorageFee: string;
}

export interface EvidenceRow {
  fn: string;
  module: string;
  gasUsed: GasUsed;
  digest: string;
  timestamp: string;
  context?: unknown;
}

export interface K2ProofContext {
  validator_index: number;
  relay_slot: number;
  relay_miner_id: string;
  proof_ordinal: number;
  K: 2;
  N: 4;
}

export interface K2ProofRow extends EvidenceRow {
  context: K2ProofContext;
}

export interface GasTotals {
  transactionCount: number;
  computation: bigint;
  storage: bigint;
  rebate: bigint;
  nonRefundable: bigint;
  irreversible: bigint;
  net: bigint;
}

export interface K2Aggregate {
  proofRows: K2ProofRow[];
  fixedRows: EvidenceRow[];
  proofTotals: GasTotals;
  fixedTotals: GasTotals;
  sessionTotals: GasTotals;
}

export interface ParsedK2Evidence {
  meta: Record<string, unknown>;
  rows: EvidenceRow[];
  rawSha256: string;
}

const SESSION_FIXED = [
  'create_room',
  'create_escrow',
  'submit_pairing_proposal',
  'close_room',
  'distribute_rewards',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonNegativeInteger(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer string`);
  }
  return value;
}

function parseEvidenceRow(value: unknown, lineNumber: number): EvidenceRow {
  if (!isRecord(value)) throw new Error(`line ${lineNumber}: expected an object`);
  const gas = value['gasUsed'];
  if (!isRecord(gas)) throw new Error(`line ${lineNumber}: gasUsed missing`);
  const fn = value['fn'];
  const module = value['module'];
  const digest = value['digest'];
  const timestamp = value['timestamp'];
  if (typeof fn !== 'string' || typeof module !== 'string') {
    throw new Error(`line ${lineNumber}: fn/module must be strings`);
  }
  if (typeof digest !== 'string' || digest.length === 0) {
    throw new Error(`line ${lineNumber}: digest missing`);
  }
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`line ${lineNumber}: timestamp must be ISO-like`);
  }
  return {
    fn,
    module,
    digest,
    timestamp,
    context: value['context'],
    gasUsed: {
      computationCost: requireNonNegativeInteger(gas['computationCost'], `line ${lineNumber} computationCost`),
      storageCost: requireNonNegativeInteger(gas['storageCost'], `line ${lineNumber} storageCost`),
      storageRebate: requireNonNegativeInteger(gas['storageRebate'], `line ${lineNumber} storageRebate`),
      nonRefundableStorageFee: requireNonNegativeInteger(
        gas['nonRefundableStorageFee'],
        `line ${lineNumber} nonRefundableStorageFee`,
      ),
    },
  };
}

export function parseK2Evidence(raw: string): ParsedK2Evidence {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error('raw evidence must contain provenance plus transaction rows');
  const parsed = lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`line ${index + 1}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const meta = parsed[0];
  if (!isRecord(meta) || meta['meta'] !== true) {
    throw new Error('line 1 must be the provenance row with meta=true');
  }
  if (meta['K'] !== 2 || meta['N'] !== 4) {
    throw new Error(`provenance must declare K=2 and N=4 (got K=${String(meta['K'])}, N=${String(meta['N'])})`);
  }
  if (meta['complete'] !== true) throw new Error('provenance must declare complete=true');
  return {
    meta,
    rows: parsed.slice(1).map((value, index) => parseEvidenceRow(value, index + 2)),
    rawSha256: sha256Text(raw),
  };
}

function parseProofContext(value: unknown, rowIndex: number): K2ProofContext {
  if (!isRecord(value)) throw new Error(`proof row ${rowIndex}: context missing`);
  const validatorIndex = value['validator_index'];
  const relaySlot = value['relay_slot'];
  const relayMinerId = value['relay_miner_id'];
  const proofOrdinal = value['proof_ordinal'];
  if (!Number.isInteger(validatorIndex) || Number(validatorIndex) < 0 || Number(validatorIndex) >= 4) {
    throw new Error(`proof row ${rowIndex}: validator_index must be 0..3`);
  }
  if (!Number.isInteger(relaySlot) || Number(relaySlot) < 0 || Number(relaySlot) >= 2) {
    throw new Error(`proof row ${rowIndex}: relay_slot must be 0..1`);
  }
  if (typeof relayMinerId !== 'string' || relayMinerId.length === 0) {
    throw new Error(`proof row ${rowIndex}: relay_miner_id missing`);
  }
  if (!Number.isInteger(proofOrdinal) || Number(proofOrdinal) < 1 || Number(proofOrdinal) > 8) {
    throw new Error(`proof row ${rowIndex}: proof_ordinal must be 1..8`);
  }
  if (value['K'] !== 2 || value['N'] !== 4) {
    throw new Error(`proof row ${rowIndex}: context must declare K=2 and N=4`);
  }
  return {
    validator_index: Number(validatorIndex),
    relay_slot: Number(relaySlot),
    relay_miner_id: relayMinerId,
    proof_ordinal: Number(proofOrdinal),
    K: 2,
    N: 4,
  };
}

export function validateK2ProofRows(rows: EvidenceRow[]): K2ProofRow[] {
  const proofRows = rows.filter(
    (row) => row.fn === 'submit_session_proof' && row.module === 'economic_layer',
  );
  if (proofRows.length !== 8) {
    throw new Error(`expected exactly 8 submit_session_proof rows for K=2/N=4, got ${proofRows.length}`);
  }

  const seenPairs = new Set<string>();
  const seenOrdinals = new Set<number>();
  const seenDigests = new Set<string>();
  const relayBySlot = new Map<number, string>();
  const validated = proofRows.map((row, index): K2ProofRow => {
    const context = parseProofContext(row.context, index + 1);
    const pair = `${context.validator_index}|${context.relay_slot}`;
    if (seenPairs.has(pair)) throw new Error(`duplicate validator/relay proof pair: ${pair}`);
    if (seenOrdinals.has(context.proof_ordinal)) {
      throw new Error(`duplicate proof_ordinal: ${context.proof_ordinal}`);
    }
    if (seenDigests.has(row.digest)) throw new Error(`duplicate proof digest: ${row.digest}`);
    const slotRelay = relayBySlot.get(context.relay_slot);
    if (slotRelay !== undefined && slotRelay !== context.relay_miner_id) {
      throw new Error(`relay_slot ${context.relay_slot} maps to multiple relay_miner_id values`);
    }
    seenPairs.add(pair);
    seenOrdinals.add(context.proof_ordinal);
    seenDigests.add(row.digest);
    relayBySlot.set(context.relay_slot, context.relay_miner_id);
    return { ...row, context };
  });

  if (relayBySlot.size !== 2 || new Set(relayBySlot.values()).size !== 2) {
    throw new Error('K=2 proof rows must cover two distinct assigned relays');
  }
  for (let validatorIndex = 0; validatorIndex < 4; validatorIndex += 1) {
    for (let relaySlot = 0; relaySlot < 2; relaySlot += 1) {
      if (!seenPairs.has(`${validatorIndex}|${relaySlot}`)) {
        throw new Error(`missing proof pair validator=${validatorIndex}, relay_slot=${relaySlot}`);
      }
    }
  }
  for (let ordinal = 1; ordinal <= 8; ordinal += 1) {
    if (!seenOrdinals.has(ordinal)) throw new Error(`missing proof_ordinal: ${ordinal}`);
  }
  return validated;
}

function sumRows(rows: EvidenceRow[]): GasTotals {
  const totals = rows.reduce(
    (acc, row) => ({
      computation: acc.computation + BigInt(row.gasUsed.computationCost),
      storage: acc.storage + BigInt(row.gasUsed.storageCost),
      rebate: acc.rebate + BigInt(row.gasUsed.storageRebate),
      nonRefundable: acc.nonRefundable + BigInt(row.gasUsed.nonRefundableStorageFee),
    }),
    { computation: 0n, storage: 0n, rebate: 0n, nonRefundable: 0n },
  );
  return {
    transactionCount: rows.length,
    ...totals,
    irreversible: totals.computation + totals.nonRefundable,
    net: totals.computation + totals.storage - totals.rebate,
  };
}

export function aggregateK2Session(rows: EvidenceRow[]): K2Aggregate {
  const proofRows = validateK2ProofRows(rows);
  const fixedRows = SESSION_FIXED.map((fn) => {
    const matching = rows.filter((row) => row.fn === fn);
    if (matching.length !== 1) throw new Error(`expected exactly one ${fn} row, got ${matching.length}`);
    return matching[0]!;
  });

  const lastProofIndex = Math.max(
    ...proofRows.map((proof) => rows.findIndex((row) => row.digest === proof.digest)),
  );
  const closeIndex = rows.indexOf(fixedRows[3]!);
  const distributionIndex = rows.indexOf(fixedRows[4]!);
  if (closeIndex <= lastProofIndex || distributionIndex <= closeIndex) {
    throw new Error('raw row order must be eight proofs, then close_room, then distribute_rewards');
  }

  return {
    proofRows,
    fixedRows,
    proofTotals: sumRows(proofRows),
    fixedTotals: sumRows(fixedRows),
    sessionTotals: sumRows([...fixedRows, ...proofRows]),
  };
}

function mistToSui(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 1_000_000_000n;
  const fraction = (absolute % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction.length > 0 ? `.${fraction}` : ''}`;
}

function usd(value: bigint, suiUsd: number): string {
  return (Number(value) / 1_000_000_000 * suiUsd).toFixed(6);
}

function totalsLine(label: string, totals: GasTotals, suiUsd: number): string {
  return `| ${label} | ${totals.transactionCount} | ${totals.computation} | ${totals.irreversible} | ${totals.net} | ${mistToSui(totals.irreversible)} | ${mistToSui(totals.net)} | $${usd(totals.irreversible, suiUsd)} | $${usd(totals.net, suiUsd)} |`;
}

export function renderK2Aggregate(
  parsed: ParsedK2Evidence,
  aggregate: K2Aggregate,
  rawPath: string,
  suiUsd = 1.5,
): string {
  if (!Number.isFinite(suiUsd) || suiUsd <= 0) throw new Error(`SUI/USD scenario must be positive: ${suiUsd}`);
  const lines: string[] = [
    '# On-chain full-session cost aggregation — actual K=2, N=4',
    `raw: ${rawPath.replace(/\\/g, '/')}`,
    `raw-sha256: ${parsed.rawSha256}`,
    `run-id: ${String(parsed.meta['runId'])}`,
    `provenance: protocolVersion=${String(parsed.meta['protocolVersion'])} RGP=${String(parsed.meta['referenceGasPrice'])} framework=${String(parsed.meta['frameworkRev'])} contracts=${String(parsed.meta['contractCommit'])} daemons=${String(parsed.meta['daemonCommit'])}`,
    `SUI/USD scenario (design assumption, not a market measurement): $${suiUsd.toFixed(2)}`,
    '',
    '## Eight measured proof transactions',
    '| ordinal | validator_index | relay_slot | relay_miner_id | computation | storage | rebate | nonRefundable | net | digest |',
    '|--:|--:|--:|---|--:|--:|--:|--:|--:|---|',
  ];
  for (const row of aggregate.proofRows) {
    const gas = row.gasUsed;
    const net = BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
    lines.push(
      `| ${row.context.proof_ordinal} | ${row.context.validator_index} | ${row.context.relay_slot} | ${row.context.relay_miner_id} | ${gas.computationCost} | ${gas.storageCost} | ${gas.storageRebate} | ${gas.nonRefundableStorageFee} | ${net} | ${row.digest} |`,
    );
  }
  lines.push(
    '',
    '## Actual transaction sums',
    '| class | txs | computation MIST | irreversible MIST | net MIST | irreversible SUI | net SUI | irreversible USD | net USD |',
    '|---|--:|--:|--:|--:|--:|--:|--:|--:|',
    totalsLine('proofs (actual K×N)', aggregate.proofTotals, suiUsd),
    totalsLine('session fixed', aggregate.fixedTotals, suiUsd),
    totalsLine('full session K=2/N=4', aggregate.sessionTotals, suiUsd),
    '',
    'Computation-only is the `computation MIST` column. Irreversible is computation + non-refundable storage fee. Net is computation + storage − rebate. The USD columns are a labelled price scenario, not a measured market price.',
  );
  return `${lines.join('\n')}\n`;
}
