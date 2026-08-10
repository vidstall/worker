/**
 * Cascade-tree Phase T-B — I1 handler-wiring: a NON-root chain-primary DIALS
 * its TREE PARENT (not re-gated on role).
 *
 * ⚠️ REVIEW-ONLY (NOT RED-on-revert). This is a function-COMPOSITION of the
 * handler's decision fns, NOT the booted RoomAssigned poller — reverting the
 * index.ts handler's dial wiring (index.ts:1029-1041) would NOT turn this
 * red. It does NOT close index.ts:1037's handler-wiring TODO; that remains a
 * T-C live obligation. The PURE dial (resolveTreeParentDial) is already
 * RED-on-revert unit-covered (relay-endpoint-resolver.test.ts, incl. the
 * non-sorted I1 regression).
 *
 * Run:
 *   pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *     apps/relay/src/__tests__/integration/tree-multihop-handler-wiring.integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import { toCanonicalRelayId, determineRole } from '@dvconf/inter-relay-client';
import { InMemoryRelayEndpointCache } from '@dvconf/shared';
import { deriveTreePosition, type TreePosition } from '../../tree-position.js';
import { resolveTreeParentDial } from '../../relay-endpoint-resolver.js';

// ── SHAPING degree that FORCES the depth-2 tree (B1) ──────────────────────────
const RMS_TREE_DEGREE = 2;
const RMS_TREE_MAX_HEIGHT = 3;

// ══════════════════════════════════════════════════════════════════════════════
// B) I1 handler-wiring: a NON-root chain-primary DIALS its TREE PARENT (not re-gated on role)
//    ⚠️ REVIEW-ONLY (NOT RED-on-revert). This is a function-COMPOSITION of the handler's decision
//    fns, NOT the booted RoomAssigned poller — reverting the index.ts handler's dial wiring
//    (index.ts:1029-1041) would NOT turn this red. It does NOT close index.ts:1037's handler-wiring
//    TODO; that remains a T-C live obligation. The PURE dial (resolveTreeParentDial) is already
//    RED-on-revert unit-covered (relay-endpoint-resolver.test.ts, incl. the non-sorted I1 regression).
// ══════════════════════════════════════════════════════════════════════════════
describe('I1 handler-wiring (REQ-RMS-042) — the tree dial follows TREE role, not chain slot-0 [composition, review-only]', () => {
  it('composition: a non-root chain-primary would dial its tree parent via the RoomAssigned decision sequence (determineRole→deriveTreePosition→resolveTreeParentDial→connectTo), NOT re-gated on role===primary', () => {
    // DISCLOSURE: this composes the RoomAssigned handler's DECISION FNS (index.ts:1000-1041) — it is
    // NOT the booted poller (which needs a full daemon: chain client, EventPoller, standbyLinkManager),
    // so it is REVIEW-ONLY, NOT RED-on-revert, and does NOT close index.ts:1037's TODO (T-C tracks it).
    // relay_ids are UNSORTED so chain slot-0 (0x02) is NOT the tree root (0x00 = sorted-min canonical).
    const relayIds = ['0x02', '0x00', '0x01', '0x03', '0x04'];
    const myMinerId = '0x02'; // chain slot-0 → chain-PRIMARY, but NOT the tree root
    const cache = new InMemoryRelayEndpointCache();
    for (const raw of relayIds) cache.setUrl(toCanonicalRelayId(raw), `ws://${raw}.node:4100`);

    // (1) it genuinely IS a chain-primary (the case that would be WRONGLY skipped if the dial were
    //     re-gated on role==='primary' — a chain-primary "doesn't dial").
    expect(determineRole(relayIds, myMinerId)).toBe('primary');

    // (2) the handler derives + stores the tree position, then dials via resolveTreeParentDial.
    const roomTreePosition = new Map<string, TreePosition>();
    const pos = deriveTreePosition(relayIds, myMinerId, RMS_TREE_DEGREE, RMS_TREE_MAX_HEIGHT);
    roomTreePosition.set('room-i1', pos);
    expect(pos.role).not.toBe('root');                    // slot-0 is NOT the tree root
    expect(pos.parent).toBe(toCanonicalRelayId('0x00'));  // its tree parent IS the sorted-min root

    const dials: string[] = [];
    const connectTo = (u: string): void => { dials.push(u); }; // stub for standbyLinkManager.connectTo
    const dialUrl = resolveTreeParentDial(roomTreePosition.get('room-i1'), cache);
    if (dialUrl !== null) connectTo(dialUrl);

    // (3) it dialed the TREE PARENT (0x00), NOT nobody, NOT the chain slot-0 self.
    const parentUrl = cache.getUrl(toCanonicalRelayId('0x00'));
    expect(dialUrl).toBe(parentUrl);
    expect(dials).toEqual([parentUrl]);

    // Contrast: the TRUE tree root (0x00, itself a chain-standby slot-1 here) dials NOBODY.
    const rootPos = deriveTreePosition(relayIds, '0x00', RMS_TREE_DEGREE, RMS_TREE_MAX_HEIGHT);
    expect(rootPos.parent).toBeNull();
    expect(resolveTreeParentDial(rootPos, cache)).toBeNull();
  });
});
