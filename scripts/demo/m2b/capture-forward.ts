/**
 * m2b/capture-forward.ts — CAPTURE: real browser → evil-relay → F1 pipe → validator sink → captured
 * forwarded bytes. Extracted verbatim from the original single-file m2b-live-bhermetic-slash.ts —
 * pure code movement, no behavior change.
 */
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import type { Logger } from '../../../packages/shared/src/index.ts';
// Capture topology (REUSED from Task 4A) — real browser producer + real signaling + the demo-only
// byzantine evil-relay + the F1 pipe + the validator sink.
import { startRealSignaling } from '../../../apps/validator-daemon/src/canary/test-support/real-signaling-harness.ts';
import { startBrowserCanaryProducer } from '../../../apps/validator-daemon/src/canary/test-support/browser-canary-producer.ts';
import { startEvilRelayForward } from '../../../apps/validator-daemon/src/canary/test-support/evil-relay-forward.ts';
import { attachValidatorSink } from '../../../apps/validator-daemon/src/canary/pipe-tap.ts';
// Relative SOURCE path (NOT the bare `@dvconf/inter-relay-client` specifier): scripts/ sits OUTSIDE
// the pnpm workspace package graph, so the bare name is unresolvable from root node_modules (only
// apps/* carry the symlink) — same constraint as the @dvconf/shared import above (seed-bootstrap:61).
import { createPrimaryPipeTransport, createStandbyPipeTransport, pipeProducerOntoPrimaryTransport } from '../../../packages/inter-relay-client/src/index.ts';
// Track-C: the cross-host F1 SRTP-handshake return channel (vm2 standby params -> primary#2.connect).
import { awaitPeerStandbyParams } from '../cross-host-pipe.ts';
// B-WAN (REQ-MLW-B-12): the CANARY_PIPE_PARAMS_PATH writer the DEPLOYED peer validator index.ts reads.
import { writeCanaryPipeParams } from '../write-canary-pipe-params.ts';
import { MOD, need, sleep, crossHostF1Endpoints, K_ROOM, CELL_SECRET, CANARY_KID, CTRS } from './common.ts';

export const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: 101 },
];

export interface CaptureResult {
  /** The REAL forwarded RTP packets captured at the validator sink. */
  captured: Buffer[];
  /** The roomId the canary derived K_canary from (== the on-chain room). */
  roomId: string;
}

/**
 * Run ONE full-cast capture leg for the given roomId + byzantine flag. Mirrors the Task-4A topology
 * but with a SINGLE in-process host-side validator sink (the ≥2-distinct comes from the on-chain
 * attester set, not from 2 capture procs). Returns the captured forwarded bytes.
 */
export async function captureForwardedLeg(roomId: string, byzantine: boolean, logger: Logger): Promise<CaptureResult> {
  // I1: declare every resource handle ABOVE the try so the finally can null-guard-close it. Any
  // rejecting await between worker-create and the (previously success-only) teardown would otherwise
  // leak 2 mediasoup workers (native subprocesses) + the signaling WS port + the Chromium process,
  // accumulating orphans across re-runs. The finally runs on BOTH success and error paths.
  let worker: msTypes.Worker | undefined;
  let validatorWorker: msTypes.Worker | undefined;
  let relayRouter: msTypes.Router | undefined;
  let validatorRouter: msTypes.Router | undefined;
  let signaling: Awaited<ReturnType<typeof startRealSignaling>> | undefined;
  let producer: Awaited<ReturnType<typeof startBrowserCanaryProducer>> | undefined;
  let evil: Awaited<ReturnType<typeof startEvilRelayForward>> | undefined;
  let sink: Awaited<ReturnType<typeof attachValidatorSink>> | undefined;
  let primaryPipe: msTypes.PipeTransport | undefined;
  let standbyPipe: msTypes.PipeTransport | undefined;
  // Track-C cross-host leg (xhost only): a SECOND relay primary pipe to vm2 + the fan of the SAME evil
  // output producer onto it. Both null on the loopback default (byte-identical single-host teardown).
  let primaryPipe2: msTypes.PipeTransport | undefined;
  let piped2Consumer: msTypes.Consumer | undefined;

  const captured: Buffer[] = [];
  let onRtp: ((pkt: Buffer) => void) | undefined;

  try {
    worker = await mediasoup.createWorker({ logLevel: 'warn' });
    relayRouter = await worker.createRouter({ mediaCodecs });
    validatorWorker = await mediasoup.createWorker({ logLevel: 'warn' });
    validatorRouter = await validatorWorker.createRouter({ mediaCodecs });

    // The REAL production signaling server over the test-owned relayRouter (router-handle bridge).
    signaling = await startRealSignaling({ relayRouter, roomId });
    // A4-live: a REAL headless-Chromium canary joins via real signaling + produces on relayRouter.
    producer = await startBrowserCanaryProducer({
      signalingUrl: signaling.wsUrl,
      roomId,
      kRoom: K_ROOM,
      cellSecret: CELL_SECRET,
      canaryKid: CANARY_KID,
      ctrs: CTRS,
    });

    // F1: a primary pipe on the relay router connected to a standby pipe on the validator router.
    // B-WAN (REQ-MLW-B-11/14, Task-7.1): env-gated cross-host F1 leg. crossHostF1Endpoints() is non-null
    // ONLY in the 2-host run (CANARY_PEER_VPN_IP set) → the pair is announced on the routable VPN/VNet
    // ifaces so the hop can traverse the WAN; PIPE_SRTP=1 wraps it (createPrimary/StandbyPipeTransport
    // already read pipeSrtpEnabled()). Under cross-host the primary binds a FIXED port (CANARY_RELAY_PIPE_
    // PORT, default 40000, inside PIPE_PORT_RANGE) so the deployed peer validator's SIGNED manifest
    // relayPipe {ip,port} + the CANARY_PIPE_PARAMS_PATH file can reference a known endpoint. UNSET =>
    // 127.0.0.1 + ephemeral port 0, BYTE-IDENTICAL to the single-process hermetic path.
    const xhost = crossHostF1Endpoints();
    // LOCAL pair primary#1 <-> standby#1 is ALWAYS loopback (127.0.0.1, ephemeral port) — it is vm1's
    // OWN capture leg for att1, on-host regardless of xhost. (Pre-Track-C the cross-host wiring tried to
    // reuse THIS pair for vm2 by announcing peerVpnIp on a locally-bound port — an impossible 1:1 that
    // never ran live; vm2's leg is now a SEPARATE primary#2 below.) Under PIPE_SRTP=1 the loopback pair
    // still exchanges SRTP params (both handles are in-process); flag-OFF omits srtpParameters so
    // connect() is byte-identical to the pre-Track-C single-host path.
    standbyPipe = await createStandbyPipeTransport(validatorRouter, 0);
    primaryPipe = await createPrimaryPipeTransport(relayRouter, 0);
    await primaryPipe.connect({
      ip: '127.0.0.1',
      port: standbyPipe.tuple.localPort,
      ...(standbyPipe.srtpParameters !== undefined ? { srtpParameters: standbyPipe.srtpParameters } : {}),
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    await standbyPipe.connect({
      ip: '127.0.0.1',
      port: primaryPipe.tuple.localPort,
      ...(primaryPipe.srtpParameters !== undefined ? { srtpParameters: primaryPipe.srtpParameters } : {}),
    } as Parameters<msTypes.PipeTransport['connect']>[0]);

    // The demo-only byzantine evil-relay taps the real producer → pipes onto the primary (INV-B reuse).
    evil = await startEvilRelayForward({
      relayRouter,
      sourceProducerId: producer.producerId,
      byzantine,
      pipeTransport: primaryPipe,
      // B-18: deterministic withholding for the DROP run (X = calibrated, above the budget).
      // TAMPER/HONEST legs leave CANARY_EVIL_DROP_EVERY_N unset => undefined => no drop, byte-identical.
      dropEveryN: Number(process.env['CANARY_EVIL_DROP_EVERY_N']) || undefined,
    });
    // Track-C GENUINE 2-host co-sign (REQ-MLW-B-12, Task-7.2): in cross-host mode stand up a SECOND relay
    // primary pipe to vm2 and FAN the SAME evil output producer onto it (pipeProducerOntoPrimaryTransport)
    // so vm2 captures the byte-identical tampered forward and attests INDEPENDENTLY (the >=2-distinct-
    // across-hosts headline). primary#2 binds the FIXED CANARY_RELAY_PIPE_PORT (default 40000) + carries
    // SRTP params under PIPE_SRTP=1. We publish {relayVpnIp, port, srtpParameters} + vm2's piped descriptor
    // + the re-derivation secrets to CANARY_PIPE_PARAMS_PATH (scp'd OOB to vm2 — INV-C: kRoom/cellSecret
    // are LOCAL-file factors, NEVER on a socket), then BLOCK on vm2's standby return (scp'd back) and
    // connect primary#2 to it. No-op on the loopback path (xhost === null) — byte-identical single-host.
    if (xhost && process.env['CANARY_PIPE_PARAMS_PATH']) {
      const paramsPath = process.env['CANARY_PIPE_PARAMS_PATH'];
      primaryPipe2 = await createPrimaryPipeTransport(
        relayRouter,
        parseInt(process.env['CANARY_RELAY_PIPE_PORT'] ?? '40000', 10),
      );
      // Fan the evil OUTPUT producer onto primary#2. Consuming pre-connect is fine (media flows once
      // both ends connect); its descriptor is what vm2's standby re-produces to see the SAME bytes.
      piped2Consumer = await pipeProducerOntoPrimaryTransport(primaryPipe2, evil.outProducerId);
      writeCanaryPipeParams(paramsPath, {
        relay: { ip: xhost.relayVpnIp, port: primaryPipe2.tuple.localPort },
        // SRTP params for the cross-host hop (present only under PIPE_SRTP=1; omitted otherwise).
        ...(primaryPipe2.srtpParameters !== undefined ? { srtpParameters: primaryPipe2.srtpParameters } : {}),
        piped: {
          id: piped2Consumer.id,
          kind: piped2Consumer.kind,
          rtpParameters: piped2Consumer.rtpParameters,
          producerPaused: piped2Consumer.producerPaused,
        },
        receiverMinerId: need(
          process.env['CANARY_PIPE_RECEIVER_MINER_ID'],
          'CANARY_PIPE_RECEIVER_MINER_ID (peer validator-2 miner_id — cross-host pipe params)',
        ),
        roomId, // Track-C: so vm2 re-derives the identical expected canary hashes (verifyForwardedCanary)
        canaryKid: CANARY_KID,
        expectedCtrs: CTRS,
        kRoom: K_ROOM,
        cellSecret: CELL_SECRET,
      });
      logger.info(
        { module: MOD, action: 'wrote_pipe_params', context: { paramsPath, relayPort: primaryPipe2.tuple.localPort } },
        'Track-C: wrote CANARY_PIPE_PARAMS_PATH for the peer host vm2 (cross-host primary#2 capture)',
      );
      // BLOCK for vm2's standby {ip,port,srtpParameters} return (the driver scps it back to vm1), then
      // connect primary#2 cross-host so media flows to vm2. Fail-loud on timeout (CANARY_COSIGN_TIMEOUT_MS).
      const returnPath = need(
        process.env['CANARY_PIPE_RETURN_PATH'],
        'CANARY_PIPE_RETURN_PATH (vm2 standby params return file — cross-host F1)',
      );
      const timeoutMs = Number(process.env['CANARY_COSIGN_TIMEOUT_MS']) || 120_000;
      const peerStandby = await awaitPeerStandbyParams(returnPath, timeoutMs);
      await primaryPipe2.connect({
        ip: peerStandby.ip,
        port: peerStandby.port,
        ...(peerStandby.srtpParameters !== undefined ? { srtpParameters: peerStandby.srtpParameters } : {}),
      } as Parameters<msTypes.PipeTransport['connect']>[0]);
      logger.info(
        { module: MOD, action: 'primary2_connected', context: { peerIp: peerStandby.ip, peerPort: peerStandby.port } },
        'Track-C: primary#2 connected to vm2 standby (cross-host media path up)',
      );
    }

    // Re-produce the piped descriptor on the validator side, then attach an UNPAUSED sink consumer.
    const pipedProducer = await standbyPipe.produce({
      id: evil.pipedProducerId,
      kind: evil.kind,
      rtpParameters: evil.rtpParameters,
      paused: evil.producerPaused,
    } as Parameters<msTypes.PipeTransport['produce']>[0]);
    sink = await attachValidatorSink(validatorRouter, pipedProducer.id);

    // Capture forwarded bytes off the sink's DirectTransport-fed consumer (copy off the reused buffer).
    onRtp = (pkt: Buffer): void => { captured.push(Buffer.from(pkt)); };
    sink.consumer.on('rtp', onRtp);

    producer.start();
    // Let real RTP flow long enough to capture the tampered ctr(s). The fake-VP8 device + the synthetic
    // canary transform produce continuously; a few seconds is ample for the 8-frame canary set to recur.
    // The BYZANTINE leg gets +2s so MORE frames flow → a corrupted ctr reliably lands in the capture
    // window (a thin window could miss the tampered frame and look like a false negative).
    await sleep(byzantine ? 6000 : 4000);

    logger.info({ module: MOD, action: 'capture_done', context: { byzantine, packets: captured.length } },
      `captured ${captured.length} forwarded packets (byzantine=${byzantine})`);

    return { captured, roomId };
  } finally {
    // Teardown runs on BOTH the success and the error path (I1). signaling first in its own guard (it
    // holds an OS port + a worker); the rest best-effort + null-guarded. producer.close() tears down
    // the Chromium process, so closing the producer here also covers the browser on the error path.
    if (sink && onRtp) { try { sink.consumer.off?.('rtp', onRtp); } catch { /* best-effort */ } }
    // M1: producer.stop() is a formal no-op (the browser fake-VP8 device keeps producing); close()
    // below is what tears down the Chromium browser process.
    producer?.stop();
    try { await signaling?.stop(); } catch { /* best-effort */ }
    try {
      sink?.close();
      evil?.close();
      piped2Consumer?.close();
      primaryPipe?.close();
      standbyPipe?.close();
      primaryPipe2?.close();
      producer?.close();
      relayRouter?.close();
      validatorRouter?.close();
      worker?.close();
      validatorWorker?.close();
    } catch { /* best-effort */ }
  }
}
