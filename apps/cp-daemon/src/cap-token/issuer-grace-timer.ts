/**
 * F62 Phase 3.4 — cap-token-issuer grace-timer machinery.
 *
 * Pure extraction from issuer.ts: cancelPendingGrace/scheduleGraceRefresh/
 * executeRefresh as free functions over an explicit `IssuerGraceCtx`
 * (extends issuer-submit.ts's `IssuerSubmitCtx` with the grace-timer/nonce
 * state). CapTokenIssuer's methods build the ctx and delegate here.
 */
import { buildRefreshCanonicalMsg, bytesToHex } from './canonical-messages.js';
import { submitRevokeOld, type IssuerSubmitCtx } from './issuer-submit.js';

export interface IssuerGraceCtx extends IssuerSubmitCtx {
  /**
   * Phase 3.4 REQ-ADM-014 — pending grace timers. Keyed by miner-id (role-change /
   * role-assigned) so that a B→A revert can cancel a prior A→B pending timer via
   * `clearTimeout`. Map entries are cleared when the timer fires OR is cancelled.
   */
  graceTimers: Map<string, NodeJS.Timeout>;
  graceMs: number;
  /**
   * Phase 3.4 REQ-ADM-013 — anti-replay nonce tracking. Key: `${roomId}::${peerHex}`,
   * value: highest nonce dispatched on a refresh TX for that (room, peer) pair.
   */
  nonces: Map<string, number>;
}

/**
 * Cancel any pending grace timer for the given minerId. Called BEFORE
 * scheduling a new timer; if a prior timer exists (e.g. previous role-change
 * is being superseded by a revert), `clearTimeout` aborts it and a single
 * INFO log line records the cancellation for operator visibility.
 *
 * The cancel-on-revert mandate (REQ-ADM-014 + briefing) treats any
 * subsequent role-change/role-assigned event for the same minerId as the
 * canonical reverse-direction signal — the issuer does NOT inspect
 * old_role/new_role pairings, since the second event by definition
 * supersedes the first (whatever its direction). This is the safest
 * interpretation: if both events ultimately fire refreshes, the second
 * one's parameters win.
 */
export function cancelPendingGrace(
  ctx: IssuerGraceCtx,
  minerId: string,
  kind: 'role-change' | 'role-assigned',
  traceId: string,
): boolean {
  let cancelled = false;
  const timerKey = `${minerId}::${kind}`;
  const existing = ctx.graceTimers.get(timerKey);
  if (existing) {
    clearTimeout(existing);
    ctx.graceTimers.delete(timerKey);
    cancelled = true;
    ctx.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: { timer_key: timerKey, miner_id: minerId, kind },
      },
      'grace timer cancelled — role reverted before 60s window',
    );
  }
  // Also cancel a timer scheduled under the OPPOSITE kind for the same
  // minerId — a role-change can be superseded by a role-assigned and vice
  // versa, per REQ-ADM-014 cancel-on-revert semantics.
  const oppositeKey = `${minerId}::${kind === 'role-change' ? 'role-assigned' : 'role-change'}`;
  const opposite = ctx.graceTimers.get(oppositeKey);
  if (opposite) {
    clearTimeout(opposite);
    ctx.graceTimers.delete(oppositeKey);
    cancelled = true;
    ctx.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: { timer_key: oppositeKey, miner_id: minerId, kind: 'opposite' },
      },
      'grace timer cancelled — role reverted before 60s window',
    );
  }
  return cancelled;
}

/**
 * Schedule a refresh that fires after `ctx.graceMs`. Only enqueues a real timer
 * when the caller supplied affectedTokenId + roomId + peerPubkey (test
 * fixtures without this context fall through to a log-only path so the
 * existing onRoleChanged-without-token fixture still exercises dedupe).
 */
export function scheduleGraceRefresh(
  ctx: IssuerGraceCtx,
  minerId: string,
  kind: 'role-change' | 'role-assigned',
  refreshCtx: {
    affectedTokenId?: string;
    roomId?: string;
    peerPubkey?: number[];
    newRole: number;
  },
  traceId: string,
): void {
  if (!refreshCtx.affectedTokenId || !refreshCtx.roomId || !refreshCtx.peerPubkey) {
    return;
  }

  const timerKey = `${minerId}::${kind}`;
  const timer = setTimeout(() => {
    ctx.graceTimers.delete(timerKey);
    // executeRefresh is async; we intentionally do not await here (setTimeout
    // callback is sync). Errors are absorbed inside executeRefresh.
    void executeRefresh(
      ctx,
      {
        oldTokenId: refreshCtx.affectedTokenId!,
        roomId: refreshCtx.roomId!,
        peerPubkey: refreshCtx.peerPubkey!,
        newRole: refreshCtx.newRole,
      },
      timerKey,
      traceId,
    );
  }, ctx.graceMs);
  ctx.graceTimers.set(timerKey, timer);
}

/**
 * Phase 3.4 + C4 inject (Case B). Builds canonical refresh payload, increments
 * the per-(room,peer) nonce, collects M-of-N quorum, submits refresh TX, then
 * follows with a revoke_capability_token_via_quorum TX for the OLD token
 * (reason=4 refresh-driven) so cap-token-cache.ts evicts the stale entry on
 * the next CapabilityRevoked chain event.
 *
 * Case B chosen: Move `refresh_capability_token` (room_capability.move
 * S54 commit `e3780d3`) emits ONLY `CapabilityRefreshed` — it does NOT emit
 * `CapabilityRevoked` for the old token despite mutating `old_token.revoked =
 * true`. cap-token-cache fast-path eviction at lines 156-159 depends on the
 * revoke event. The follow-up TX ensures REQ-ADM-005 ≤5s eviction holds.
 *
 * Defense narrative: chain-as-SOT (Fork 3) — the cache reacts to canonical
 * chain events; we never derive eviction logic from the refresh event
 * payload (which lacks an old-token-id field), so the second TX is the
 * defensible path until Move-side emits both events atomically (post-thesis).
 */
export async function executeRefresh(
  ctx: IssuerGraceCtx,
  refreshCtx: { oldTokenId: string; roomId: string; peerPubkey: number[]; newRole: number },
  dedupeKey: string,
  traceId: string,
): Promise<void> {
  try {
    const peerHex = bytesToHex(refreshCtx.peerPubkey);
    const nonceKey = `${refreshCtx.roomId}::${peerHex}`;
    const currentNonce = ctx.nonces.get(nonceKey) ?? 0;
    const nextNonce = currentNonce + 1;

    const newExpiresEpoch = ctx.resolveExpiresEpoch(); // W-P2 D-W7: live epoch + offset (was 100n placeholder)
    const canonicalMsg = buildRefreshCanonicalMsg({
      oldTokenId: refreshCtx.oldTokenId,
      newRole: refreshCtx.newRole,
      newExpiresEpoch,
      refreshNonce: nextNonce,
    });

    const { qs, pubkeys, aggregateSig } = await ctx.keystore.collectQuorumSignatures(
      canonicalMsg,
      ctx.threshold,
    );

    // Increment nonce BEFORE TX submit so a concurrent replay attempt sees
    // the bumped counter and gets rejected.
    ctx.nonces.set(nonceKey, nextNonce);

    const refreshResult = await ctx.submitFn({
      label: 'refresh-capability-token',
      args: {
        target: `${ctx.packageId}::room_capability::refresh_capability_token`,
        networkRegistryId: ctx.networkRegistryId,
        cpRegistryObjectId: ctx.cpRegistryObjectId,
        quorumStateObjectId: ctx.quorumStateObjectId,
        oldTokenId: refreshCtx.oldTokenId,
        newRole: refreshCtx.newRole,
        newExpiresEpoch,
        refreshNonce: nextNonce,
        cpQuorumProof: qs,
        signerPubkeys: pubkeys,
        // D-011: aggregate_sig param between signer_pubkeys and ctx
        aggregateSig,
        canonicalMsg: Array.from(canonicalMsg),
      },
    });

    ctx.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: {
          dedupe_key: dedupeKey,
          handler: 'executeRefresh',
          tx_digest: refreshResult.digest,
          old_token_id: refreshCtx.oldTokenId,
          refresh_nonce: nextNonce,
        },
      },
      'TX submitted',
    );

    // C4 Case B: follow-up revoke-old TX so cap-token-cache evicts the old entry.
    await submitRevokeOld(ctx, refreshCtx.oldTokenId, dedupeKey, traceId);
  } catch (err) {
    ctx.logger.error(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: { dedupe_key: dedupeKey, err: (err as Error).message },
      },
      'executeRefresh failed — quorum collection or TX submit error',
    );
  }
}
