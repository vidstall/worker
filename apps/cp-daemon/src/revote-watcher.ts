/**
 * Re-vote watcher — F47 Phase 2.1 (REQ-RV-009).
 *
 * Periodically scans on-chain state for miners that should re-enter the role
 * vote pool and submits permissionless `mark_revote_eligible_*` TXs:
 *   - IDLE: a node whose `last_heartbeat` has gone stale beyond `max_idle_epochs`.
 *   - COMPOSITION_SHIFT: a node whose role is over-supplied (raw scarcity ratio
 *     below `SCARCITY_FLOOR_BPS`).
 *
 * The mark entries themselves re-validate every condition on-chain (this daemon
 * is advisory — it only decides *which* miners to nominate). A 14-epoch cooldown
 * (`revote_eligible_since`) is mirrored locally to avoid wasting gas on TXs the
 * chain would abort with E_COOLDOWN.
 *
 * Design: all chain reads go through the {@link ChainStateReader} seam so the
 * decision logic is unit-testable offline (no devInspect). The live
 * `SuiChainStateReader` is wired against localnet in Phase 4.1 (RV-013).
 *
 * Structured logging: every action emits `{ trace_id, module: 'revote-watcher',
 * action: 'scan_idle' | 'scan_composition' | 'mark_tx', context }` (pino).
 *
 * Implements REQ-RV-009.
 */

import { randomUUID } from 'node:crypto';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, MinerRole, type NetworkConfig, type Logger } from '@dvconf/shared';

const MODULE = 'revote-watcher';

/** Minimum per-role scarcity share in basis points — mirrors constants::scarcity_floor_bps (500 = 5%). */
export const SCARCITY_FLOOR_BPS = 500n;
/** Basis-points denominator — mirrors constants::basis_points (10_000). */
export const BASIS_POINTS = 10_000n;
/** Default scan cadence in epochs. Read it via {@link resolveScanIntervalEpochs}. */
export const DEFAULT_SCAN_INTERVAL_EPOCHS = 5;

/**
 * Resolve the scan cadence (in epochs) from the REVOTE_SCAN_INTERVAL_EPOCHS env var,
 * falling back to {@link DEFAULT_SCAN_INTERVAL_EPOCHS} when unset, empty, or invalid.
 * The epoch→ms conversion happens at the index.ts wiring site (Phase 4.1), where the
 * live epoch duration is known.
 */
export function resolveScanIntervalEpochs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['REVOTE_SCAN_INTERVAL_EPOCHS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_SCAN_INTERVAL_EPOCHS;
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SCAN_INTERVAL_EPOCHS;
}

/**
 * Re-vote reason codes — MUST match the `reason: u8` field emitted by
 * `RevoteEligibleMarked` on-chain (role_voting.move): 1=IDLE, 2=COMPOSITION_SHIFT,
 * 3=MINER_REQUEST.
 */
export enum MarkReason {
  Idle = 1,
  CompositionShift = 2,
  MinerRequest = 3,
}

/** A miner's role + last-heartbeat epoch, as read from the role-specific registry. */
export interface MinerHeartbeat {
  minerId: string;
  role: number; // MinerRole
  lastHeartbeat: bigint;
}

/** Active node counts across the three role registries. */
export interface RoleCounts {
  relay: bigint;
  validator: bigint;
  cp: bigint;
}

/**
 * Read seam for on-chain state the watcher needs. The real implementation wraps
 * `SuiClient.devInspectTransactionBlock`; tests inject an in-memory fake.
 */
export interface ChainStateReader {
  /** Current Sui epoch. */
  getCurrentEpoch(): Promise<bigint>;
  /** Active miners with their role + last_heartbeat epoch. */
  getActiveMiners(): Promise<MinerHeartbeat[]>;
  /** Active counts across the three role registries. */
  getRoleCounts(): Promise<RoleCounts>;
  /** `revote_eligible_since[minerId]` on-chain, or null if the miner was never marked. */
  getRevoteEligibleSince(minerId: string): Promise<bigint | null>;
  /** `RoleVoteBox.max_idle_epochs` (governance-tunable, default 30). */
  getMaxIdleEpochs(): Promise<bigint>;
  /** `RoleVoteBox.revote_cooldown_epochs` (governance-tunable, default 14 days). */
  getRevoteCooldownEpochs(): Promise<bigint>;
}

/** Submits a single `mark_revote_eligible_*` TX. Injected so the watcher logic stays chain-free. */
export type MarkSubmitter = (minerId: string, reason: MarkReason, traceId: string) => Promise<void>;

export interface RevoteWatcherOptions {
  /** Scarcity floor in bps below which a role is "surplus". Default {@link SCARCITY_FLOOR_BPS}. */
  scarcityFloorBps?: bigint;
}

/**
 * Determine which roles are over-supplied, mirroring the RAW pre-clamp scarcity
 * math in `mark_revote_eligible_composition_shift` (role_voting.move).
 *
 * NOTE: we deliberately do NOT use `get_scarcity_ratios` — that getter clamps
 * surplus roles to the floor, making `ratio < floor` always false (role_voting.move
 * line 435 documents this footgun). Computing the raw ratio here keeps the daemon's
 * candidate selection in lock-step with the on-chain authority (no wasted TXs).
 */
export function computeSurplusRoles(counts: RoleCounts, floorBps: bigint): Set<number> {
  const surplus = new Set<number>();
  const total = counts.relay + counts.validator + counts.cp;
  if (total === 0n) return surplus; // empty network → treated as balanced on-chain

  const rawRelay = total / (counts.relay > 0n ? counts.relay : 1n);
  const rawValidator = total / (counts.validator > 0n ? counts.validator : 1n);
  const rawCp = total / (counts.cp > 0n ? counts.cp : 1n);
  const rawTotal = rawRelay + rawValidator + rawCp;
  if (rawTotal === 0n) return surplus;

  // Per-role surplus test — identical bigint math to the Move authority
  // (mark_revote_eligible_composition_shift, role_voting.move:462-470): surplus iff
  // the raw pre-clamp ratio falls below the floor. No count==0 special-case: a
  // zero-count role has raw = total (maximal), so its ratio is the highest possible —
  // never below floor — and it has no miners to mark anyway.
  const flag = (raw: bigint, role: number): void => {
    if ((raw * BASIS_POINTS) / rawTotal < floorBps) surplus.add(role);
  };
  flag(rawRelay, MinerRole.Relay);
  flag(rawValidator, MinerRole.Validator);
  flag(rawCp, MinerRole.CP);
  return surplus;
}

/**
 * Scans chain state and nominates miners for re-vote. Pure decision logic over a
 * {@link ChainStateReader} + {@link MarkSubmitter} — no SuiClient dependency.
 */
export class RevoteWatcher {
  /** Local mirror of on-chain `revote_eligible_since` to short-circuit cooldown checks. */
  private readonly eligibleSinceMirror = new Map<string, bigint>();
  private readonly floorBps: bigint;

  constructor(
    private readonly reader: ChainStateReader,
    private readonly submitter: MarkSubmitter,
    private readonly logger: Logger,
    options: RevoteWatcherOptions = {},
  ) {
    this.floorBps = options.scarcityFloorBps ?? SCARCITY_FLOOR_BPS;
  }

  /**
   * Identify active miners whose idle gap STRICTLY exceeds `max_idle_epochs`.
   * Strict `>` matches the on-chain N2 rule (gap == max_idle is still grace).
   */
  async scanIdleMiners(): Promise<string[]> {
    const traceId = randomUUID();
    const [epoch, maxIdle, miners] = await Promise.all([
      this.reader.getCurrentEpoch(),
      this.reader.getMaxIdleEpochs(),
      this.reader.getActiveMiners(),
    ]);
    const idle = miners
      .filter((m) => (epoch > m.lastHeartbeat ? epoch - m.lastHeartbeat : 0n) > maxIdle)
      .map((m) => m.minerId);
    this.logger.info(
      { trace_id: traceId, module: MODULE, action: 'scan_idle', context: { epoch: epoch.toString(), maxIdle: maxIdle.toString(), candidateCount: idle.length } },
      'Revote watcher: idle scan complete',
    );
    return idle;
  }

  /** Identify active miners belonging to an over-supplied role (composition shift). */
  async scanCompositionShift(): Promise<string[]> {
    const traceId = randomUUID();
    const [counts, miners] = await Promise.all([
      this.reader.getRoleCounts(),
      this.reader.getActiveMiners(),
    ]);
    const surplusRoles = computeSurplusRoles(counts, this.floorBps);
    const excess = miners.filter((m) => surplusRoles.has(m.role)).map((m) => m.minerId);
    this.logger.info(
      { trace_id: traceId, module: MODULE, action: 'scan_composition', context: { surplusRoles: [...surplusRoles], candidateCount: excess.length } },
      'Revote watcher: composition-shift scan complete',
    );
    return excess;
  }

  /**
   * Submit a `mark_revote_eligible_*` TX for a miner, skipping if it is still
   * inside the cooldown window (epoch < since + cooldown) — matching the on-chain
   * E_COOLDOWN guard so we never burn gas on a TX the chain would abort.
   */
  async submitMarkTx(minerId: string, reason: MarkReason): Promise<'submitted' | 'skipped-cooldown'> {
    const traceId = randomUUID();
    const [epoch, cooldown] = await Promise.all([
      this.reader.getCurrentEpoch(),
      this.reader.getRevoteCooldownEpochs(),
    ]);

    let since = this.eligibleSinceMirror.get(minerId);
    if (since === undefined) {
      const onChain = await this.reader.getRevoteEligibleSince(minerId);
      if (onChain !== null) {
        since = onChain;
        this.eligibleSinceMirror.set(minerId, onChain);
      }
    }

    if (since !== undefined && epoch < since + cooldown) {
      this.logger.info(
        { trace_id: traceId, module: MODULE, action: 'mark_tx', context: { minerId, reason, skipped: 'cooldown', since: since.toString(), epoch: epoch.toString() } },
        'Revote watcher: mark skipped (cooldown)',
      );
      return 'skipped-cooldown';
    }

    await this.submitter(minerId, reason, traceId);
    this.trackEligibleSince(minerId, epoch);
    this.logger.info(
      { trace_id: traceId, module: MODULE, action: 'mark_tx', context: { minerId, reason, epoch: epoch.toString() } },
      'Revote watcher: mark TX submitted',
    );
    return 'submitted';
  }

  /** Mirror an on-chain `revote_eligible_since` entry locally (avoids a re-read next cycle). */
  trackEligibleSince(minerId: string, epoch: bigint): void {
    this.eligibleSinceMirror.set(minerId, epoch);
  }
}

/**
 * Build a real {@link MarkSubmitter} that signs + submits `mark_revote_eligible_*`
 * TXs via `executeWithRetry`. Arg order matches role_voting.move exactly
 * (net_reg, vote_box, miner_store, relay_reg, validator_reg, cp_reg, miner_id)
 * — `ctx` is implicit in a PTB (signaling_reg dropped with the standalone
 * signaling node type's removal).
 *
 * NOTE: targets the F47 Phase 1 entries, which are only callable once the new
 * package is republished (the deployed testnet v3 predates Phase 1). Exercised
 * live in Phase 4.1 against localnet.
 */
export function makeMarkSubmitter(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
): MarkSubmitter {
  const fnFor: Record<MarkReason, string | null> = {
    [MarkReason.Idle]: 'mark_revote_eligible_idle',
    [MarkReason.CompositionShift]: 'mark_revote_eligible_composition_shift',
    // Miner-request is MinerCap-gated and operator-driven (Phase 2.3 CLI), not watcher-driven.
    [MarkReason.MinerRequest]: null,
  };
  return async (minerId, reason, traceId) => {
    const fn = fnFor[reason];
    if (fn === null) {
      throw new Error(`makeMarkSubmitter: reason ${reason} (miner-request) is not watcher-submittable`);
    }
    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        tx.moveCall({
          // Package split (see services/contract/role-voting): role_voting
          // now lives in its own package, not config.packageId.
          target: `${config.roleVotingPackageId}::role_voting::${fn}`,
          arguments: [
            tx.object(config.networkRegistryId),   // net_reg: &NetworkRegistry
            tx.object(config.roleVoteBoxId),        // vote_box: &mut RoleVoteBox
            tx.object(config.minerStoreId),         // miner_store: &MinerStore
            tx.object(config.relayRegistryId),      // relay_reg: &RelayRegistry
            tx.object(config.validatorRegistryId),  // validator_reg: &ValidatorRegistry
            tx.object(config.cpRegistryId),         // cp_reg: &ControlPlaneRegistry
            tx.pure.id(minerId),                    // miner_id: ID
          ],
        });
      },
      'mark-revote-eligible',
      logger,
    );
    logger.info(
      { trace_id: traceId, module: MODULE, action: 'mark_tx', context: { minerId, fn } },
      'Revote watcher: mark TX confirmed on-chain',
    );
  };
}

/**
 * Start the periodic re-vote watch loop. Each cycle scans idle + composition-shift
 * candidates and submits cooldown-gated mark TXs. Mirrors `startRoleVoting`.
 *
 * NOTE (Phase 4 wiring): index.ts does NOT start this yet — it needs the live
 * `SuiChainStateReader` (built in Phase 4.1, RV-013) which requires on-chain view
 * getters for per-miner heartbeat + RoleVoteBox fields. Until then the loop runs
 * only in integration tests with a real reader.
 *
 * @returns a stop function that clears the interval.
 */
export function startRevoteWatcher(
  reader: ChainStateReader,
  submitter: MarkSubmitter,
  logger: Logger,
  intervalMs: number,
  options: RevoteWatcherOptions = {},
): () => void {
  const watcher = new RevoteWatcher(reader, submitter, logger, options);
  logger.info({ module: MODULE, context: { intervalMs } }, 'Starting revote watch loop');

  const poll = async (): Promise<void> => {
    try {
      const idle = await watcher.scanIdleMiners();
      for (const minerId of idle) {
        try {
          await watcher.submitMarkTx(minerId, MarkReason.Idle);
        } catch (err) {
          logger.warn({ module: MODULE, context: { minerId, err } }, 'Revote watcher: idle mark failed');
        }
      }
      const shifted = await watcher.scanCompositionShift();
      for (const minerId of shifted) {
        try {
          await watcher.submitMarkTx(minerId, MarkReason.CompositionShift);
        } catch (err) {
          logger.warn({ module: MODULE, context: { minerId, err } }, 'Revote watcher: composition mark failed');
        }
      }
    } catch (err) {
      logger.error({ module: MODULE, context: { err } }, 'Revote watcher: poll cycle failed');
    }
  };

  void poll();
  const handle = setInterval(() => void poll(), intervalMs);
  return () => {
    clearInterval(handle);
    logger.info({ module: MODULE }, 'Revote watch loop stopped');
  };
}
