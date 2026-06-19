/**
 * REQ-CFA-002 / INV-A — Covert canary PUBLISHER (validator-daemon media plane).
 *
 * THE OTHER HALF of the load-bearing INV-A proof: a Wallet-B validator covertly
 * injects an INDISTINGUISHABLE canary SFrame stream into a real relay so the
 * Phase-1.1 verifier (verifier.ts) can recompute it byte-for-byte downstream. This
 * is NET-NEW for the validator-daemon: it has NO mediasoup dependency today (the
 * media plane here is STUN+HTTP probing only — probe.ts), so the live transport is a
 * THIN, typed seam (`CovertJoinTransport`) exercised end-to-end in the Phase-4 E2E;
 * the pure frame-production core below is unit-testable WITHOUT mediasoup.
 *
 * DRY (load-bearing — a divergent re-implementation is a FAIL): the publisher does
 * NOT re-implement the P_i / canarySeed / codecOffset / encryptFrame chain. It REUSES
 * the verifier's exported frame-builder (`recomputeCanaryFrame` + `deriveCanarySeed`)
 * verbatim, so the produced wire bytes are — by construction, not by coincidence —
 * EXACTLY the bytes `verifyForwardedCanary` recomputes for the same
 * (kRoom, roomId, cellSecret, canaryKid, ctrs). Feeding `produce()` output straight
 * into the verifier as a self-forward yields byteIdentical == mediaPackets, 0
 * divergences (see publisher.test.ts).
 *
 * COVERTNESS (DESIGN §5 covert-leak caveat): a real PASSWORD join broadcasts the
 * joiner into the room roster (signaling `peerJoined` broadcast → DESIGN §5 cites
 * signaling.ts:791 `uniquePeers` + :833 `rosterPeer`). The canary MUST be invisible
 * to that roster, so it joins via the NO-PASSWORD path (`withPassword: false`) — no
 * roster broadcast, no `rosterPeer` entry. The relay still forwards its media (it is
 * a real producer on the SFU), but no peer is told a new member appeared. Wiring this
 * to the production no-password admission path is the Phase-4 live leg; the seam below
 * fixes the covert CONTRACT (withPassword=false) that the live transport must honor.
 *
 * LOGGING (HARD-GATE): NEVER log key material / cellSecret / P_i / K_canary. The only
 * structured logs here are { relayHomeId, canaryKid, frames } ids/integers.
 */

import { createLogger } from '@dvconf/shared';
// Single source of truth for the canary frame layout (Phase-1.1 verifier). We REUSE
// its exported builder — we do NOT re-derive K_canary / P_i / codecOffset here.
import { recomputeCanaryFrame, deriveCanarySeed } from './verifier.js';

const MOD = 'canary/publisher';
const log = createLogger(MOD);

/** Inputs to the pure frame-production core (one frame per ctr in `ctrs`). */
export interface CanaryProduceInput {
  kRoom: Uint8Array;
  roomId: string;
  /** Per-cell out-of-band secret (the covert factor; salt in the PathC mix). */
  cellSecret: Uint8Array;
  canaryKid: number;
  /** The canonical canary frame order (drives P_i and the trailer ctr). */
  ctrs: number[];
}

/** Inputs to a covert publish run = which relay to home on + the frames to emit. */
export interface CanaryPublishInput extends CanaryProduceInput {
  /** The relay whose forward path this canary cell audits. */
  relayHomeId: string;
}

/**
 * The live media-plane seam (Phase-4 E2E supplies a mediasoup-client / in-process
 * DirectTransport producer implementation; tests supply a fake). It is deliberately
 * minimal: COVERTLY join a relay home, then push opaque SFrame bodies onto the SFU as
 * a single-layer (L1T1) VP8 producer. `withPassword` is the covert contract — the
 * canary MUST pass `false` so the join takes the no-roster-broadcast path.
 */
export interface CovertJoinTransport {
  /** Covertly join `relayHomeId`. `withPassword:false` ⇒ NO roster broadcast (DESIGN §5). */
  join(opts: { relayHomeId: string; withPassword: boolean }): Promise<void>;
  /** Emit one canary SFrame body on the media plane (the relay forwards it opaquely). */
  sendBody(body: Uint8Array): Promise<void>;
}

/**
 * Covert canary publisher. The pure frame-production core (`produce`) reuses the
 * verifier's builder; `publish` wires the covert no-password join + media-plane
 * emission over a typed transport seam.
 */
export class CanaryPublisher {
  /**
   * Produce the canonical canary SFrame stream for `ctrs` — the PURE, transport-free
   * core. Each frame is `recomputeCanaryFrame(...)` (the verifier's builder), so the
   * bytes are byte-identical to what the verifier recomputes. Derives `canarySeed`
   * ONCE; recomputes each C_i in ctr order. Reproducible from `cellSecret` alone.
   */
  async produce(input: CanaryProduceInput): Promise<Uint8Array[]> {
    const canarySeed = deriveCanarySeed(input.cellSecret);
    const base = {
      kRoom: input.kRoom,
      roomId: input.roomId,
      cellSecret: input.cellSecret,
      canaryKid: input.canaryKid,
    };
    const frames: Uint8Array[] = [];
    for (const ctr of input.ctrs) {
      frames.push(await recomputeCanaryFrame(base, canarySeed, ctr));
    }
    return frames;
  }

  /**
   * Covertly publish the canary stream to `relayHomeId`: join via the NO-PASSWORD
   * path (no roster broadcast — DESIGN §5 covertness), then emit every produced frame
   * in ctr order on the media plane. Returns the produced frames so the caller (and
   * the verifier) can reference the exact wire bytes. The full live media-plane
   * transport is exercised in the Phase-4 E2E; here the transport is the typed seam.
   */
  async publish(input: CanaryPublishInput, transport: CovertJoinTransport): Promise<Uint8Array[]> {
    // Covert join FIRST — no-password ⇒ the relay forwards our media but no peer is
    // told a new member appeared (no roster broadcast). This is the covert contract.
    await transport.join({ relayHomeId: input.relayHomeId, withPassword: false });

    const frames = await this.produce(input);
    for (const frame of frames) {
      await transport.sendBody(frame);
    }

    log.info(
      { relayHomeId: input.relayHomeId, canaryKid: input.canaryKid, frames: frames.length },
      'covert canary stream published (no-password join, no roster broadcast)',
    );
    return frames;
  }
}
