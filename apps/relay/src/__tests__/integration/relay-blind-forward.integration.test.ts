/**
 * W5 M2 Phase 5 — RELAY BLIND-FORWARD INVARIANT (REQ-MCS-011).
 *
 * The relay-blind invariant for Content E2EE (Option A, SFrame / RFC 9605): the
 * relay forwards an SFrame-encrypted producer's RTP reading ONLY the cleartext
 * RTP/SFrame header for routing + M1 simulcast layer-select — it MUST NOT decode
 * or mutate the encrypted payload. This file PROVES that invariant on REAL
 * mediasoup over DirectTransport, reusing the M1 bandwidth-bench backbone
 * (makeVp8Rtp / makeRtcpSenderReport semantics, G-MCS-1).
 *
 * See relay-blind-forward.fixtures.ts for the SFrame-over-VP8 packet builders,
 * the per-layer SFrame tile harness (real mediasoup DirectTransport producer +
 * capturing consumer), and the forwarded-body locator/measurement helpers.
 *
 * SFrame model (CONTRACTS.md §2, RFC 9605 §4.4.3 — cleartext header || ciphertext
 * || tag). The relay only ever sees VP8 RTP, so we model an SFrame frame INSIDE
 * the VP8 RTP payload:
 *
 *   RTP header (12B) | VP8 descriptor | VP8 keyframe/interframe header
 *                    | [SFrame: Config byte | KID | CTR] | ciphertext body | tag
 *
 * The VP8 descriptor + keyframe header stay parseable (real VP8 keyframe start
 * code) so the SimulcastConsumer can still switch spatial layers (G-MCS-1 — the
 * relay routes/selects on cleartext metadata). Everything AFTER the VP8 header
 * (the SFrame header + ciphertext body + tag) is OPAQUE to the relay.
 *
 * ── Two invariants proven ────────────────────────────────────────────────────
 *   (1) BLIND / BYTE-PRESERVING: capture the forwarded RTP on the consumer side
 *       (DirectTransport consumers emit a per-packet 'rtp' event). The ciphertext
 *       body is byte-IDENTICAL to what was sent. mediasoup rewrites only RTP
 *       header fields (SSRC/seq/ts) for routing; it NEVER touches the payload
 *       body => structurally there is no decode/decrypt/mutate path. We ALSO
 *       confirm the cleartext SFrame header (KID/CTR) survives unchanged so the
 *       receiver can still pick the decryption key by KID (CONTRACTS.md §2).
 *   (2) M1 LAYER-SELECT COEXISTS OVER CIPHERTEXT: with the SAME ciphertext
 *       payloads, setPreferredLayers(:0) drops forwarded outbound-rtp byteCount
 *       materially vs (:2) — the relay layer-selects on the cleartext header
 *       without ever reading the ciphertext (reuses the M1 measureScenario
 *       pattern). A documented RED hook proves GREEN is the mechanism.
 *
 * ── RED hook (mirrors the M1 bench BENCH_FORCE_OPTIMIZED_HIGH discipline) ──────
 * BLIND_FORCE_LAYER_HIGH=1 forces the "low" scenario in invariant (2) to ALSO
 * select spatialLayer:2 => low ~= high => the >=3x layer-select assertion FAILS.
 * This is the documented RED that proves the layer-select GREEN is the mechanism,
 * not a coincidence (same shape as the M1 bench red hook + the spike's
 * SPIKE_DISABLE_RTCP_SR=1). The byte-preservation invariant (1) has its own RED
 * discipline noted inline (an intentionally-wrong byte expectation fails).
 *
 * ── Honesty bounds (DA-2/DA-3, D-M2-8 — mirrors the M1 bench honesty block) ────
 * This is a RELAY-SIDE mechanism floor on a SYNTHETIC DirectTransport source —
 * NOT WAN glass-to-glass, NOT a browser getStats(), and it does NOT prove real-
 * browser SFrame-over-VP8-simulcast interop (that is P10's BROWSER relay-blind
 * proof + a real-deployment concern). The "ciphertext" here is opaque random
 * bytes standing in for a real SFrame ciphertext — it proves the relay FORWARDS
 * an opaque payload unchanged and selects layers on the cleartext header, which
 * is the structural blind-forward property; it does NOT exercise a real SFrame
 * encrypt/decrypt (client-side, P2/P3). The relay's blindness is STRUCTURAL
 * (mediasoup has no SFrame/decode path; the payload is opaque to it). The
 * validator-blindness in M2 is ECONOMIC/OPERATIONAL (it holds the key). This is
 * NEVER a cryptographic "relay/validator cannot decrypt" claim — M2 has NO
 * cryptographic validator-exclusion (Path C → M3, D-M2-7/8).
 *
 * Requirements touched: REQ-MCS-011 (relay blind-forward invariant + M1 coexist).
 *
 * Run: pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/relay-blind-forward.integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  LAYER_LOW,
  LAYER_HIGH,
  SFRAME_KID,
  FORCE_LAYER_HIGH,
  FORCE_TAMPER,
  sleep,
  makeSframeTile,
  locateForwardedSframe,
  SETTLE_MS,
  WINDOW_MS,
  measureForwarded,
} from './relay-blind-forward.fixtures.js';

describe('W5 M2 P5 — relay blind-forward invariant (REAL mediasoup, REQ-MCS-011)', () => {
  it(
    'INVARIANT (1): forwards SFrame ciphertext BYTE-IDENTICAL + cleartext KID/CTR header survives (relay is blind)',
    async () => {
      const tile = await makeSframeTile(0);
      // Hold the high layer so we capture full-size ciphertext bodies.
      await tile.consumer.setPreferredLayers({ spatialLayer: LAYER_HIGH, temporalLayer: 0 });
      await tile.consumer.requestKeyFrame();
      await sleep(SETTLE_MS);
      // let a window of packets be forwarded + captured
      await sleep(600);

      const forwarded = tile.capturedForwarded.slice();
      tile.stop();

      // GUARD: real media was forwarded + captured (no dead-pipe false-green).
      expect(forwarded.length).toBeGreaterThan(0);

      // Build a set of every ciphertext body WE SENT (any layer) so a forwarded
      // body must byte-match one of them. mediasoup may forward any subset of the
      // simulcast layers; what matters is each forwarded body is byte-identical
      // to a SENT body and the SFrame header (KID) is preserved unchanged.
      const sentBodies = new Set<string>();
      for (const layer of tile.sentCiphertextByLayer) {
        for (const body of layer) sentBodies.add(body.toString('base64'));
      }
      expect(sentBodies.size).toBeGreaterThan(0);

      let byteIdentical = 0; // forwarded packets whose SFrame body byte-matches a sent body
      let kidPreserved = 0; // …of those, how many also preserved KID == SFRAME_KID
      let mediaPackets = 0; // forwarded packets large enough to carry our SFrame body
      for (const pkt of forwarded) {
        // skip tiny artifacts (RTX/padding) that can't hold our smallest body
        if (pkt.length < 12 + 4 + 3 + 6 + 1) continue;
        mediaPackets++;
        // RED hook (BLIND_FORCE_TAMPER=1): simulate a non-blind relay that altered
        // the ciphertext body in transit — flip the last body byte so it can no
        // longer byte-match a sent body => byteIdentical < mediaPackets => fail.
        if (FORCE_TAMPER) pkt[pkt.length - 1] = (pkt[pkt.length - 1]! ^ 0xff) & 0xff;
        const found = locateForwardedSframe(pkt, sentBodies);
        if (!found) continue;
        // The ciphertext body is byte-IDENTICAL to a body we sent — the relay
        // rewrote ONLY RTP/codec HEADER fields (extension/SSRC/seq/ts/descriptor)
        // for routing, NEVER the SFrame body. (This is the byte-preservation proof.)
        byteIdentical++;
        // The cleartext SFrame KID also survives unchanged (CONTRACTS §2 — the
        // receiver picks its decryption key by this KID, so it MUST be preserved).
        if (found.kid === SFRAME_KID) kidPreserved++;
      }

      // eslint-disable-next-line no-console
      console.log(
        `[blind-forward REQ-MCS-011 invariant-1] forwarded=${forwarded.length} mediaPackets=${mediaPackets} ` +
          `ciphertextByteIdentical=${byteIdentical} kidPreserved=${kidPreserved}`,
      );

      // We must have forwarded a meaningful number of media packets.
      expect(mediaPackets).toBeGreaterThan(0);
      // EVERY forwarded media packet's ciphertext body is byte-identical to a SENT
      // body — i.e. the relay forwarded the opaque payload unchanged (no decode /
      // decrypt / mutate path). (RED: an off-by-one in the locator, or a relay
      // that mutated the body, drops byteIdentical below mediaPackets => fails.)
      expect(byteIdentical).toBe(mediaPackets);
      // …and on every one of those, the cleartext KID survived unchanged.
      expect(kidPreserved).toBe(byteIdentical);
      // Sanity: a NONSENSE body never matches (the comparison is real, not vacuous).
      expect(sentBodies.has(Buffer.from('not-a-real-ciphertext-body').toString('base64'))).toBe(false);

      tile.close();
    },
    120_000,
  );

  it(
    'INVARIANT (2): M1 layer-select drops forwarded byteCount on :0 vs :2 OVER ciphertext (>=3x; RED hook BLIND_FORCE_LAYER_HIGH)',
    async () => {
      const tile = await makeSframeTile(1);

      // HIGH scenario (:2) — active-speaker-grade, full ciphertext.
      await tile.consumer.setPreferredLayers({ spatialLayer: LAYER_HIGH, temporalLayer: 0 });
      await tile.consumer.requestKeyFrame();
      const highBytes = await measureForwarded(tile);

      // LOW scenario (:0) — thumbnail-grade. Under the RED hook, force :2 so low
      // ~= high and the ratio assertion FAILS (proves GREEN is the mechanism).
      if (FORCE_LAYER_HIGH) {
        await tile.consumer.setPreferredLayers({ spatialLayer: LAYER_HIGH, temporalLayer: 0 });
        await tile.consumer.requestKeyFrame();
      } else {
        await tile.consumer.setPreferredLayers({ spatialLayer: LAYER_LOW, temporalLayer: 0 });
      }
      const lowBytes = await measureForwarded(tile);

      const ratio = lowBytes > 0 ? highBytes / lowBytes : Infinity;
      // eslint-disable-next-line no-console
      console.log(
        `[blind-forward REQ-MCS-011 invariant-2] forwarded outbound-rtp over ${WINDOW_MS}ms: ` +
          `high(:2)=${highBytes} bytes  low(:0)=${lowBytes} bytes  ratio=${ratio.toFixed(2)}` +
          (FORCE_LAYER_HIGH ? '  [RED HOOK: BLIND_FORCE_LAYER_HIGH=1]' : ''),
      );

      tile.stop();
      tile.close();

      // GUARD: both windows carried real media (no dead-pipe false-green).
      expect(highBytes).toBeGreaterThan(0);
      expect(lowBytes).toBeGreaterThan(0);

      // The relay layer-selected over CIPHERTEXT payloads: :0 forwards materially
      // FEWER bytes than :2, WITHOUT the relay ever decoding the body. >=3x mirrors
      // the M1 single-tile ladder (~1:18 high:low; >=3x is a conservative floor).
      // RED: BLIND_FORCE_LAYER_HIGH=1 makes low~=high => ratio~1 => this FAILS.
      expect(ratio).toBeGreaterThanOrEqual(3.0);
    },
    120_000,
  );
});
