/**
 * REQ-CFA-002 (Phase 1 / Task 1.2) — covert canary publisher tests.
 *
 * Proves the covert canary PUBLISHER (validator-daemon media plane — NET-NEW; the
 * validator-daemon has NO mediasoup dep today) produces a reproducible canary SFrame
 * stream whose wire bytes EXACTLY EQUAL what the Phase-1.1 verifier expects, and that
 * its join uses the COVERT no-password path (no roster broadcast).
 *
 * DRY (load-bearing): the publisher MUST NOT re-implement the P_i / canarySeed /
 * codecOffset / encryptFrame chain. It REUSES the verifier's exported frame-builder
 * (`recomputeCanaryFrame` + `deriveCanarySeed`, verifier.ts). The decisive test is a
 * SELF-FORWARD: feed the publisher's produced frames straight into the verifier's
 * `verifyForwardedCanary` as the `captured` set — an honest (no-tamper) forward MUST
 * yield byteIdentical == mediaPackets and 0 divergences. A divergent re-implementation
 * that drifts a single byte FAILS this assert.
 *
 * COVERTNESS: a real password join broadcasts the joiner into the roster
 * (signaling rooms.ts `peerJoined` broadcast; DESIGN §5 covert-leak caveat —
 * signaling.ts:791 uniquePeers / :833 rosterPeer). The canary publisher MUST take the
 * NO-PASSWORD path so it is invisible to the roster. We assert the covert transport
 * seam's join carries `withPassword === false` and emits NO roster broadcast.
 *
 * LOGGING (HARD-GATE): NEVER log key material / cellSecret / P_i / K_canary. The
 * publisher only structured-logs { canaryKid, relayHomeId, frames } integers/ids.
 */

import { describe, it, expect } from 'vitest';

// Client crypto (vendored into @dvconf/shared) reused only for layout self-checks.
import { readSframeTrailer, SFRAME_TRAILER_LEN } from '@dvconf/shared';
// The Phase-1.1 verifier is the SINGLE SOURCE OF TRUTH for the canary frame layout.
import {
  verifyForwardedCanary,
  recomputeCanaryFrame,
  deriveCanarySeed,
  CANARY_FRAME_LEN,
  CANARY_SFRAME_LEN,
  type VerifyInput,
} from '../verifier.js';
import {
  CanaryPublisher,
  type CovertJoinTransport,
  type CanaryProduceInput,
} from '../publisher.js';

const SFRAME_CONFIG_BYTE = 0x01;

// ── Fixed per-cell canary inputs (NOT roster keying) ───────────────────────────
const CELL_SECRET = new Uint8Array(32).fill(0xab);
const K_ROOM = new Uint8Array(32).fill(0x5c);
const ROOM_ID = 'cfa-canary-publish-room';
const RELAY_HOME_ID = 'relay-home-7';
const CANARY_KID = 7;
const N_FRAMES = 6;

const produceInput = (ctrs: number[]): CanaryProduceInput => ({
  kRoom: K_ROOM,
  roomId: ROOM_ID,
  cellSecret: CELL_SECRET,
  canaryKid: CANARY_KID,
  ctrs,
});

const verifyInput = (expectedCtrs: number[]): VerifyInput => ({
  kRoom: K_ROOM,
  roomId: ROOM_ID,
  cellSecret: CELL_SECRET,
  canaryKid: CANARY_KID,
  expectedCtrs,
});

/**
 * A fake covert transport seam: records what was joined + every body "sent" on the
 * media plane. It models the Phase-4 live leg (mediasoup-client / DirectTransport
 * producer) as a thin typed interface so the pure frame-production core is unit-testable
 * WITHOUT mediasoup. `join` records the password flag; `sendBody` captures the wire bytes
 * exactly as a real producer would put them on the SFU.
 */
class FakeCovertTransport implements CovertJoinTransport {
  joinedRelayHomeId: string | null = null;
  joinedWithPassword: boolean | null = null;
  rosterBroadcasts = 0;
  readonly sent: Uint8Array[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async join(opts: { relayHomeId: string; withPassword: boolean }): Promise<void> {
    this.joinedRelayHomeId = opts.relayHomeId;
    this.joinedWithPassword = opts.withPassword;
    // A real PASSWORD join would broadcast the joiner into the roster; the no-password
    // covert path does NOT. Model that here so the covertness assert has teeth.
    if (opts.withPassword) this.rosterBroadcasts++;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async sendBody(body: Uint8Array): Promise<void> {
    this.sent.push(Uint8Array.prototype.slice.call(body));
  }
}

describe('REQ-CFA-002 CanaryPublisher.produce — DRY byte-equality with the verifier', () => {
  it('(a) produced frames EQUAL the verifier-recomputed expected set (DRY, no re-implementation)', async () => {
    const ctrs = Array.from({ length: N_FRAMES }, (_, i) => i);
    const publisher = new CanaryPublisher();
    const frames = await publisher.produce(produceInput(ctrs));

    expect(frames.length).toBe(ctrs.length);

    // The verifier's OWN recompute is the reference. Byte-equality here proves the
    // publisher reused the shared builder rather than drifting a parallel chain.
    const canarySeed = deriveCanarySeed(CELL_SECRET);
    for (let i = 0; i < ctrs.length; i++) {
      const expected = await recomputeCanaryFrame(
        { kRoom: K_ROOM, roomId: ROOM_ID, cellSecret: CELL_SECRET, canaryKid: CANARY_KID },
        canarySeed,
        ctrs[i]!,
      );
      expect(Buffer.from(frames[i]!).equals(Buffer.from(expected))).toBe(true);
    }
  });

  it('(a) every produced frame carries the real partial-SFrame layout (config 0x01 trailer, fixed length, kid+ctr)', async () => {
    const ctrs = Array.from({ length: N_FRAMES }, (_, i) => i);
    const frames = await new CanaryPublisher().produce(produceInput(ctrs));

    expect(CANARY_FRAME_LEN).toBeGreaterThanOrEqual(10);
    frames.forEach((s, i) => {
      expect(s.length).toBe(CANARY_SFRAME_LEN);
      expect(s[s.length - SFRAME_TRAILER_LEN]).toBe(SFRAME_CONFIG_BYTE);
      const t = readSframeTrailer(s);
      expect(t.kid).toBe(CANARY_KID);
      expect(t.ctr).toBe(i);
      expect(t.codecOffset).toBe(10);
    });
    // The PRF is non-degenerate: all frames are distinct.
    expect(new Set(frames.map((b) => Buffer.from(b).toString('base64'))).size).toBe(frames.length);
  });

  it('(a) SELF-FORWARD: publisher output fed to verifyForwardedCanary ⇒ byteIdentical==mediaPackets, 0 divergences', async () => {
    // Wrap each produced SFrame body in a VP8-ish RTP packet shape (12-byte RTP header
    // + descriptor + the body as the LAST CANARY_SFRAME_LEN bytes), exactly what the
    // verifier's fixed-length tail extractor expects. An honest "forward" (no tamper)
    // MUST verify clean — the publisher and verifier agree byte-for-byte.
    const ctrs = Array.from({ length: N_FRAMES }, (_, i) => i);
    const frames = await new CanaryPublisher().produce(produceInput(ctrs));

    const captured: Buffer[] = frames.map((body) => {
      const rtpHeader = Buffer.alloc(12);
      rtpHeader[0] = 0x80;
      rtpHeader[1] = 0xe5;
      const desc = Buffer.from([0x90, 0x80, 0x00, 0x01]); // VP8 descriptor stand-in
      return Buffer.concat([rtpHeader, desc, Buffer.from(body)]);
    });

    const result = await verifyForwardedCanary(captured, verifyInput(ctrs));

    expect(result.mediaPackets).toBe(ctrs.length);
    expect(result.byteIdentical).toBe(result.mediaPackets);
    expect(result.divergences.length).toBe(0);
  });
});

describe('REQ-CFA-002 CanaryPublisher.publish — covert no-password join + media-plane emission', () => {
  it('(b) joins via the NO-PASSWORD path (no roster broadcast) and emits every produced frame', async () => {
    const ctrs = Array.from({ length: N_FRAMES }, (_, i) => i);
    const transport = new FakeCovertTransport();
    const publisher = new CanaryPublisher();

    const frames = await publisher.publish(
      { relayHomeId: RELAY_HOME_ID, ...produceInput(ctrs) },
      transport,
    );

    // Covertness (DESIGN §5): the join is the no-password path → NO roster broadcast.
    expect(transport.joinedRelayHomeId).toBe(RELAY_HOME_ID);
    expect(transport.joinedWithPassword).toBe(false);
    expect(transport.rosterBroadcasts).toBe(0);

    // Every produced frame was emitted on the media plane, in order, byte-identical.
    expect(transport.sent.length).toBe(ctrs.length);
    frames.forEach((f, i) => {
      expect(Buffer.from(transport.sent[i]!).equals(Buffer.from(f))).toBe(true);
    });
  });

  it('(b) the emitted frames verify clean against the verifier (publish ≡ produce on the wire)', async () => {
    const ctrs = Array.from({ length: N_FRAMES }, (_, i) => i);
    const transport = new FakeCovertTransport();
    await new CanaryPublisher().publish(
      { relayHomeId: RELAY_HOME_ID, ...produceInput(ctrs) },
      transport,
    );

    // The bytes the covert transport carried are exactly what the verifier expects.
    const captured = transport.sent.map((body) => Buffer.concat([Buffer.alloc(16), Buffer.from(body)]));
    const result = await verifyForwardedCanary(captured, verifyInput(ctrs));
    expect(result.mediaPackets).toBe(ctrs.length);
    expect(result.byteIdentical).toBe(result.mediaPackets);
    expect(result.divergences.length).toBe(0);
  });
});
