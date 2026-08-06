/**
 * SuiChainStateReader — live implementation of the {@link ChainStateReader}
 * seam (F47 Phase 4.0, REQ-RV-013).
 *
 * Wraps `SuiClient.devInspectTransactionBlock` (+ a dynamic-field read for the
 * cooldown table) so the {@link RevoteWatcher} decision logic can run against a
 * real chain. All reads are read-only — no TX is signed or submitted here.
 *
 * devInspect convention (read-only): build a {@link Transaction}, add a single
 * `moveCall`, then `devInspectTransactionBlock({ transactionBlock, sender: ZERO })`.
 * The first command's first return value is a BCS `number[]`; decode it with the
 * matching `bcs` schema. Errors / missing results throw a contextual Error.
 *
 * BCS struct field order is LOAD-BEARING — BCS is positional, so the per-registry
 * NodeInfo schemas below mirror the deployed Move struct field order EXACTLY
 * (verified against dvconf-contracts/sources/** by the orchestrator). A wrong
 * order silently mis-decodes; the unit test round-trips each layout to guard it.
 *
 * Structured logging only (pino child via the injected Logger). No console.log,
 * no hardcoded ids/urls — every id comes from the injected {@link NetworkConfig}.
 *
 * Implements REQ-RV-013.
 */

import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { MinerRole, type NetworkConfig, type Logger } from '@dvconf/shared';
import type { ChainStateReader, MinerHeartbeat, RoleCounts } from './revote-watcher.js';

const MODULE = 'sui-chain-state-reader';

/** Sender used for read-only devInspect calls (no gas, no signature). */
const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

// ── BCS schemas mirroring the deployed Move NodeInfo structs ─────────────────
// Field order MUST match the Move struct declaration order per registry — these
// differ across registries (CP/Signaling carry an `is_active` bool the others
// don't, and field ordering varies). Sourced from the orchestrator's live read
// of dvconf-contracts/sources/**.

/** relay_registry::RelayNodeInfo */
const RelayNodeInfoSchema = bcs.struct('RelayNodeInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  reputation: bcs.u64(),
  registered_at: bcs.u64(),
  last_heartbeat: bcs.u64(),
  region: bcs.vector(bcs.u8()),
  endpoint_url: bcs.vector(bcs.u8()),
  reserved_primary_count: bcs.u64(),
  reserved_standby_count: bcs.u64(),
});

/** validator_registry::ValidatorInfo */
const ValidatorInfoSchema = bcs.struct('ValidatorInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  reputation: bcs.u64(),
  registered_at: bcs.u64(),
  last_heartbeat: bcs.u64(),
  session_count: bcs.u64(),
});

/** control_plane_registry::CPNodeInfo */
const CPNodeInfoSchema = bcs.struct('CPNodeInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  last_heartbeat: bcs.u64(),
  is_active: bcs.bool(),
  registered_at: bcs.u64(),
  reputation: bcs.u64(),
});

/** signaling_registry::SignalingNodeInfo */
const SignalingNodeInfoSchema = bcs.struct('SignalingNodeInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  last_heartbeat: bcs.u64(),
  is_active: bcs.bool(),
  endpoint_url: bcs.vector(bcs.u8()),
  region: bcs.vector(bcs.u8()),
  load: bcs.u64(),
  registered_at: bcs.u64(),
});

/** Minimal shape of a devInspect result we read (avoids importing the SDK type). */
interface DevInspectLike {
  error?: string | null;
  results?: Array<{ returnValues?: Array<[number[], string]> } | undefined> | null;
}

/**
 * An active CP projected to the identity columns the G2 quorum assembler needs:
 * the on-chain `miner_id` plus the registered `operator` ADDRESS that
 * {@link ChainStateReader} consumers (`toHeartbeat`) otherwise discard. No peer
 * URL / session_wallet is surfaced (INV-C: operator addresses are PUBLIC).
 */
export interface CpOperator {
  /** The CP node id (control_plane_registry::CPNodeInfo.miner_id). */
  minerId: string;
  /** The registered operator address — the `qs.signers` column verify_quorum iterates. */
  operator: string;
}

/**
 * Raised when {@link SuiChainStateReader.readMinQuorum} is asked to read the
 * on-chain threshold but the `QuorumConfigState` object id is unset/empty. The
 * G5 threshold MUST come from on-chain `min_quorum`; without it the off-chain
 * board MUST NOT assemble a quorum (fail-closed) rather than fall back to a
 * guessed/env threshold the chain would reject.
 */
export class QuorumStateIdUnsetError extends Error {
  constructor() {
    super(
      'readMinQuorum: QUORUM_STATE_OBJECT_ID (QuorumConfigState id) is unset/empty — ' +
        'cannot read on-chain min_quorum; failing closed so the quorum board never assembles',
    );
    this.name = 'QuorumStateIdUnsetError';
  }
}

export class SuiChainStateReader implements ChainStateReader {
  constructor(
    private readonly client: SuiClient,
    private readonly config: NetworkConfig,
    private readonly logger: Logger,
  ) {}

  /** Current Sui epoch (no Move call — straight from the system state). */
  async getCurrentEpoch(): Promise<bigint> {
    const s = await this.client.getLatestSuiSystemState();
    const epoch = BigInt(s.epoch);
    this.logger.debug({ module: MODULE, method: 'getCurrentEpoch', epoch: epoch.toString() }, 'read current epoch');
    return epoch;
  }

  /**
   * Active miners across the four role registries, each tagged with its role +
   * last_heartbeat epoch. One devInspect per registry; empty registries decode
   * to an empty vector (→ empty array).
   */
  async getActiveMiners(): Promise<MinerHeartbeat[]> {
    const pkg = this.config.packageId;
    const [relays, validators, cps, signaling] = await Promise.all([
      this.readActiveVector(
        `${pkg}::relay_registry::get_active_relays`,
        this.config.relayRegistryId,
        RelayNodeInfoSchema,
      ),
      this.readActiveVector(
        `${pkg}::validator_registry::get_active_validators`,
        this.config.validatorRegistryId,
        ValidatorInfoSchema,
      ),
      this.readActiveVector(
        `${pkg}::control_plane_registry::get_active_cps`,
        this.config.cpRegistryId,
        CPNodeInfoSchema,
      ),
      this.readActiveVector(
        `${pkg}::signaling_registry::get_active_nodes`,
        this.config.signalingRegistryId,
        SignalingNodeInfoSchema,
      ),
    ]);

    const out: MinerHeartbeat[] = [
      ...relays.map((n) => this.toHeartbeat(n, MinerRole.Relay)),
      ...validators.map((n) => this.toHeartbeat(n, MinerRole.Validator)),
      ...cps.map((n) => this.toHeartbeat(n, MinerRole.CP)),
      ...signaling.map((n) => this.toHeartbeat(n, MinerRole.Signaling)),
    ];
    this.logger.debug(
      { module: MODULE, method: 'getActiveMiners', context: { count: out.length } },
      'read active miners',
    );
    return out;
  }

  /** Active node counts across the four role registries. */
  async getRoleCounts(): Promise<RoleCounts> {
    const pkg = this.config.packageId;
    const [relay, validator, cp, signaling] = await Promise.all([
      this.readU64(`${pkg}::relay_registry::active_count`, this.config.relayRegistryId),
      this.readU64(`${pkg}::validator_registry::active_count`, this.config.validatorRegistryId),
      this.readU64(`${pkg}::control_plane_registry::active_cp_count`, this.config.cpRegistryId),
      this.readU64(`${pkg}::signaling_registry::active_signaling_count`, this.config.signalingRegistryId),
    ]);
    this.logger.debug(
      {
        module: MODULE,
        method: 'getRoleCounts',
        context: { relay: relay.toString(), validator: validator.toString(), cp: cp.toString(), signaling: signaling.toString() },
      },
      'read role counts',
    );
    return { relay, validator, cp, signaling };
  }

  /**
   * `RoleVoteBox.revote_eligible_since[minerId]`, or null when the miner was
   * never marked. No deployed Move getter exists (`is_revote_eligible` +
   * `revote_eligible_since_epoch` are `#[test_only]`), so we read the
   * `Table<ID, u64>` field as a Sui dynamic field — TS-only, no Move change.
   *
   * Phase 4.0 only exercises the empty/not-found → null path; the precise
   * content-shape parse of the non-empty case is validated live in Phase 4.1.
   *
   * Follow-up (LOW, post-thesis): a deployed
   * `public fun revote_eligible_since_opt(box, id): Option<u64>` would give a
   * cleaner read than dynamic-field traversal.
   */
  async getRevoteEligibleSince(minerId: string): Promise<bigint | null> {
    const id = normalizeSuiAddress(minerId);
    try {
      const box = await this.client.getObject({
        id: this.config.roleVoteBoxId,
        options: { showContent: true },
      });
      const tableId = this.extractTableId(box);
      if (tableId === null) {
        this.logger.debug(
          { module: MODULE, method: 'getRevoteEligibleSince', context: { minerId: id, reason: 'unexpected-box-shape' } },
          'revote_eligible_since table id not found on RoleVoteBox',
        );
        return null;
      }

      const field = await this.client.getDynamicFieldObject({
        parentId: tableId,
        name: { type: '0x2::object::ID', value: id },
      });
      const f = field as { error?: unknown; data?: { content?: { fields?: { value?: unknown } } } | null };
      if (f.error || !f.data) return null; // dynamicFieldNotFound → never marked

      const value = f.data.content?.fields?.value;
      if (value === undefined || value === null) return null;
      const since = BigInt(value as string | number);
      this.logger.debug(
        { module: MODULE, method: 'getRevoteEligibleSince', context: { minerId: id, since: since.toString() } },
        'read revote_eligible_since',
      );
      return since;
    } catch (err) {
      this.logger.debug(
        { module: MODULE, method: 'getRevoteEligibleSince', context: { minerId: id, err } },
        'revote_eligible_since read failed; treating as not-marked',
      );
      return null;
    }
  }

  /** `RoleVoteBox.max_idle_epochs` (governance-tunable, default 30). */
  async getMaxIdleEpochs(): Promise<bigint> {
    const value = await this.readU64(
      `${this.config.roleVotingPackageId}::role_voting::max_idle_epochs`,
      this.config.roleVoteBoxId,
    );
    this.logger.debug({ module: MODULE, method: 'getMaxIdleEpochs', value: value.toString() }, 'read max_idle_epochs');
    return value;
  }

  /** `RoleVoteBox.revote_cooldown_epochs` (governance-tunable, default 14). */
  async getRevoteCooldownEpochs(): Promise<bigint> {
    const value = await this.readU64(
      `${this.config.roleVotingPackageId}::role_voting::revote_cooldown_epochs`,
      this.config.roleVoteBoxId,
    );
    this.logger.debug(
      { module: MODULE, method: 'getRevoteCooldownEpochs', value: value.toString() },
      'read revote_cooldown_epochs',
    );
    return value;
  }

  /**
   * Active CPs projected to `{ minerId, operator }` (multi-cp-quorum Leg 1, G2).
   *
   * Runs the SAME read-only `get_active_cps` devInspect as {@link getActiveMiners}
   * but preserves the `operator` ADDRESS column that `toHeartbeat` discards — the
   * `qs.signers` column the on-chain `cp_quorum_sig::verify_quorum` iterates. The
   * G2 assembler resolves each poster's pubkey → operator address against this
   * discovered set; a stranger (not in this set) is a deliberate fail-closed drop.
   *
   * Additive — NO schema change (reuses {@link CPNodeInfoSchema}); read-only; an
   * empty registry decodes to `[]`.
   */
  async getActiveCpOperators(): Promise<CpOperator[]> {
    const target = `${this.config.packageId}::control_plane_registry::get_active_cps`;
    const bytes = await this.devInspectBytes(target, this.config.cpRegistryId);
    const decoded = bcs.vector(CPNodeInfoSchema).parse(Uint8Array.from(bytes)) as Array<{
      miner_id: string;
      operator: string;
    }>;
    const out = decoded.map((n) => ({ minerId: n.miner_id, operator: n.operator }));
    this.logger.debug(
      { module: MODULE, method: 'getActiveCpOperators', context: { count: out.length } },
      'read active CP operators',
    );
    return out;
  }

  /**
   * On-chain M threshold `cp_quorum_sig::min_quorum(state)` (multi-cp-quorum Leg 1, G5).
   *
   * Read PER-ROUND (NO cache) — `min_quorum` is mutable via `update_threshold`, so
   * the off-chain board must observe the live value every assembly round, never a
   * stale snapshot (else it could assemble at a count the chain now rejects, or
   * never reach a raised threshold).
   *
   * FAIL-CLOSED: the `QuorumConfigState` id comes from the `QUORUM_STATE_OBJECT_ID`
   * plumbing, NOT from {@link NetworkConfig}. When it is unset/empty this throws
   * {@link QuorumStateIdUnsetError} WITHOUT issuing a devInspect, so a misconfigured
   * daemon never silently assembles a quorum.
   *
   * @param quorumStateObjectId the shared `QuorumConfigState` object id.
   */
  async readMinQuorum(quorumStateObjectId: string): Promise<bigint> {
    if (!quorumStateObjectId) {
      this.logger.error(
        { module: MODULE, method: 'readMinQuorum', context: { reason: 'quorum-state-id-unset' } },
        'min_quorum read refused — QuorumConfigState id unset; failing closed',
      );
      throw new QuorumStateIdUnsetError();
    }
    const value = await this.readU64(
      `${this.config.packageId}::cp_quorum_sig::min_quorum`,
      quorumStateObjectId,
    );
    this.logger.debug(
      { module: MODULE, method: 'readMinQuorum', context: { minQuorum: value.toString() } },
      'read on-chain min_quorum (per-round, no cache)',
    );
    return value;
  }

  // ── private helpers ────────────────────────────────────────────────────

  /** Map a decoded NodeInfo (any registry layout) to a {@link MinerHeartbeat}. */
  private toHeartbeat(node: { miner_id: string; last_heartbeat: string }, role: number): MinerHeartbeat {
    // `bcs.Address` already yields the canonical 0x-prefixed 66-char form.
    return { minerId: node.miner_id, role, lastHeartbeat: BigInt(node.last_heartbeat) };
  }

  /**
   * devInspect a getter that takes a single shared-object arg and returns a
   * single value; returns the raw return-value bytes. Throws (logged) on
   * devInspect error or missing results.
   */
  private async devInspectBytes(target: string, objectId: string): Promise<number[]> {
    const tx = new Transaction();
    tx.moveCall({ target, arguments: [tx.object(objectId)] });
    const r = (await this.client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: ZERO,
    })) as DevInspectLike;
    if (r.error) {
      const msg = `devInspect ${target} failed: ${r.error}`;
      this.logger.error({ module: MODULE, target, err: r.error }, msg);
      throw new Error(msg);
    }
    const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
    if (bytes === undefined) {
      const msg = `devInspect ${target} returned no values`;
      this.logger.error({ module: MODULE, target }, msg);
      throw new Error(msg);
    }
    return bytes;
  }

  /** devInspect a `u64` getter → bigint. */
  private async readU64(target: string, objectId: string): Promise<bigint> {
    const bytes = await this.devInspectBytes(target, objectId);
    return BigInt(bcs.u64().parse(Uint8Array.from(bytes)));
  }

  /** devInspect a `vector<NodeInfo>` getter → decoded array (empty vector → []). */
  private async readActiveVector<T extends { miner_id: string; last_heartbeat: string }>(
    target: string,
    objectId: string,
    schema: { parse: (bytes: Uint8Array) => T },
  ): Promise<T[]> {
    const bytes = await this.devInspectBytes(target, objectId);
    return bcs.vector(schema as never).parse(Uint8Array.from(bytes)) as unknown as T[];
  }

  /**
   * Navigate `RoleVoteBox.content.fields.revote_eligible_since.fields.id.id` to
   * the inner Table UID used as the dynamic-field parent. Returns null on any
   * unexpected shape (defensive — logged + null by the caller).
   */
  private extractTableId(box: unknown): string | null {
    const content = (box as { data?: { content?: { fields?: Record<string, unknown> } } })?.data?.content;
    const fields = content?.fields as Record<string, unknown> | undefined;
    const table = fields?.['revote_eligible_since'] as { fields?: { id?: { id?: unknown } } } | undefined;
    const id = table?.fields?.id?.id;
    return typeof id === 'string' ? id : null;
  }
}
