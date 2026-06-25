/**
 * M2b-live-WAN Sub-lane A — browser-side entry (bundled by esbuild for the headless
 * Chrome under test). FORK of scripts/bench/p10-browser/harness-entry.js.
 *
 * THE DELTA over p10: instead of SFrame-encrypting a real getUserMedia VP8 track with a
 * production per-sender K_content, this harness REPLACES each outbound encoded frame's
 * body with a fully-PINNED synthetic 62-byte CANARY SFrame, built by REUSING the SHIPPED
 * client crypto the daemon verifier cross-imports (encryptFrame + codecOffsetForFrameType
 * from sframe-transform.ts, PathCKeyDerivation from e2ee-spike.ts) and REIMPLEMENTING the
 * two trivial daemon PRF fns on WebCrypto (deriveCanarySeed=SHA-256, canaryPlaintext=
 * HMAC-SHA256 — the daemon versions use node:crypto, not browser-safe). The canary is
 * byte-identical to recomputeCanaryFrame (verifier.ts:136-151) BY CONSTRUCTION.
 *
 * The pinned pipeline (mirrors verifier.ts recomputeCanaryFrame exactly):
 *   1. seed     = SHA-256( utf8('dvconf-canary/seed/v1') || cellSecret )            (32B)
 *   2. P_i      = HMAC-SHA256( key=seed, msg=u32BE(ctr) )[0:32]                     (32B)
 *   3. K_canary = PathCKeyDerivation().deriveContentKey({ kRoom, roomId, kid:canaryKid,
 *                   senderId:'dvconf-canary/v1', oobSecret:cellSecret })            (AES-GCM-256)
 *   4. C_i      = encryptFrame(P_i, {kid:canaryKid, ctr}, K_canary, codecOffset=10) (62B)
 *
 * STILL p10 (kept verbatim): the real getUserMedia VP8 track over a REAL WebRtcTransport
 * (real ICE/DTLS on localhost) to the in-process mediasoup relay; the relay's JSON-over-WS
 * protocol verbatim; the createEncodedStreams ownership (called ONCE per sender); the
 * cipherSamples exfil over the page->Node JSON boundary as hex.
 *
 * DUAL-API MASK (DISCLOSED — harness-only, NO production edit): Chromium exposes BOTH
 * `createEncodedStreams` AND the standard `RTCRtpScriptTransform`; the shipped
 * `detectEncodedTransformApi()` PREFERS the standard API whose worker path is an unbuilt
 * no-op. We mask the standard API UNCONDITIONALLY (the canary always encrypts) so the live
 * createEncodedStreams branch runs. Disclosed at Gate A exactly as p10 does.
 *
 * LOGGING (HARD-GATE): NEVER log cellSecret / K_canary / P_i. The kid/ctr/byteLength the
 * shipped encryptFrame logs are non-secret routing integers (kept, as p10 does).
 *
 * SECURE-CONTEXT + INSERTABLE-STREAMS: same as p10 — served over http://127.0.0.1, the
 * send PC created with encodedInsertableStreams:true (a harness setting; production
 * useRelay.createSendTransport does NOT set this — a disclosed latent finding, p10 §header).
 */

import { Device } from 'mediasoup-client';
// REUSE VERBATIM — the SAME modules verifier.ts cross-imports (byte-equivalence by construction).
import {
  encryptFrame,
  codecOffsetForFrameType,
} from '../../../../dvconf-client/src/lib/webrtc/sframe-transform.ts';
import { PathCKeyDerivation } from '../../../../dvconf-client/src/lib/crypto/e2ee-spike.ts';

// ── Pinned canary constants (load-bearing; any divergence → byteId < 8) ───────────────
const CANARY_SENDER_ID = 'dvconf-canary/v1'; // keying.ts:44 — load-bearing for the HKDF info
const CANARY_SEED_LABEL = 'dvconf-canary/seed/v1'; // verifier.ts:60
const CANARY_FRAME_LEN = 32; // verifier.ts:68 (HMAC-SHA256 is 32B; no truncation)

const te = new TextEncoder();
const u32be = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false); // BIG-ENDIAN — pin #2
  return b;
};
const concat = (...a) => {
  const t = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of a) {
    t.set(x, o);
    o += x.length;
  }
  return t;
};

// REIMPLEMENT (WebCrypto) — match verifier.ts:112-117 (SHA-256, no length-prefix/separator).
async function canarySeed(cellSecret) {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', concat(te.encode(CANARY_SEED_LABEL), cellSecret)),
  );
}
// REIMPLEMENT (WebCrypto) — match verifier.ts:124-129 (HMAC-SHA256(seed, u32BE(ctr))[0:32]).
async function canaryPlaintext(seed, ctr) {
  const k = await crypto.subtle.importKey('raw', seed, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, u32be(ctr)));
  return mac.subarray(0, CANARY_FRAME_LEN);
}
// The 4-step pinned canary (inline throwaway for Task 0; Task 1 extracts it to a module).
async function buildCanaryFrame({ kRoom, roomId, cellSecret, canaryKid, ctr }) {
  const seed = await canarySeed(cellSecret); // step 1
  const pi = await canaryPlaintext(seed, ctr); // step 2  (32B P_i)
  const kCanary = await new PathCKeyDerivation().deriveContentKey({
    // step 3  — REUSED client class
    kRoom,
    roomId,
    kid: canaryKid,
    senderId: CANARY_SENDER_ID,
    oobSecret: cellSecret,
  });
  // step 4 — REUSED client encryptFrame; codecOffsetForFrameType('key',32) = 10.
  return await encryptFrame(
    pi,
    { kid: canaryKid, ctr },
    kCanary,
    codecOffsetForFrameType('key', CANARY_FRAME_LEN),
  );
}

/** Tiny request/response client over the relay WS (mirrors RelayClient; verbatim from p10). */
function makeRelayClient(url) {
  const ws = new WebSocket(url);
  const pending = [];
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + String(e))));
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return;
    }
    for (let i = 0; i < pending.length; i++) {
      if (pending[i].predicate(msg)) {
        const [m] = pending.splice(i, 1);
        m.resolve(msg);
        return;
      }
    }
  });
  return {
    ready,
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor: (predicate, timeoutMs = 15000) =>
      new Promise((resolve, reject) => {
        const entry = { predicate, resolve: (m) => { clearTimeout(t); resolve(m); } };
        const t = setTimeout(() => {
          const idx = pending.indexOf(entry);
          if (idx >= 0) pending.splice(idx, 1);
          reject(new Error('relay response timeout'));
        }, timeoutMs);
        pending.push(entry);
      }),
    close: () => ws.close(),
  };
}

async function run(opts) {
  const { relayUrl, roomId } = opts;
  // Rebuild the Uint8Arrays — page.evaluate serializes them as number[].
  const OPTS = {
    kRoom: Uint8Array.from(opts.kRoom),
    roomId,
    cellSecret: Uint8Array.from(opts.cellSecret),
    canaryKid: opts.canaryKid,
    ctrs: opts.ctrs.slice(),
  };
  console.log('[m2b-canary] start relayUrl=' + relayUrl + ' room=' + roomId + ' canaryKid=' + OPTS.canaryKid);

  // 1. Real getUserMedia (Chrome fake device → real VP8-capable video track).
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  const track = stream.getVideoTracks()[0];
  console.log('[m2b-canary] getUserMedia ok track=' + track.label);

  // 2. Relay handshake — join → routerRtpCapabilities.
  const client = makeRelayClient(relayUrl);
  await client.ready;
  client.send({ type: 'join', roomId });
  const caps = await client.waitFor((m) => m.type === 'routerRtpCapabilities');
  console.log('[m2b-canary] joined; got routerRtpCapabilities');

  // 3. Load the real Device against the relay's router caps.
  const device = new Device();
  await device.load({ routerRtpCapabilities: caps.rtpCapabilities });
  console.log('[m2b-canary] device loaded canProduceVideo=' + device.canProduce('video'));

  // 4. Create a SEND transport (real WebRtcTransport → real ICE/DTLS). encodedInsertableStreams
  // MUST be on so createEncodedStreams() attaches (disclosed harness setting — p10 §header).
  client.send({ type: 'createTransport', direction: 'send' });
  const tp = await client.waitFor((m) => m.type === 'transportCreated');
  const sendTransport = device.createSendTransport({
    id: tp.id,
    iceParameters: tp.iceParameters,
    iceCandidates: tp.iceCandidates,
    dtlsParameters: tp.dtlsParameters,
    additionalSettings: { encodedInsertableStreams: true },
  });

  sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
    try {
      client.send({ type: 'connectTransport', transportId: sendTransport.id, dtlsParameters });
      callback();
    } catch (err) {
      errback(err);
    }
  });

  let producerId = null;
  sendTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
    (async () => {
      try {
        client.send({ type: 'produce', transportId: sendTransport.id, kind, rtpParameters });
        const produced = await client.waitFor((m) => m.type === 'produced');
        producerId = produced.producerId;
        callback({ id: produced.producerId });
      } catch (err) {
        errback(err);
      }
    })().catch(errback);
  });

  sendTransport.on('connectionstatechange', (s) => {
    console.log('[m2b-canary] sendTransport connectionstatechange=' + s);
  });

  // 5. Produce the real VP8 track → triggers connect (DTLS) then produce.
  console.log('[m2b-canary] producing video track…');
  const producer = await sendTransport.produce({
    track,
    encodings: [{ maxBitrate: 1_000_000 }],
    codecOptions: { videoGoogleStartBitrate: 1000 },
  });
  console.log('[m2b-canary] produced producerId=' + producer.id);

  // 6. Own the createEncodedStreams insertable-streams pipe; REPLACE each encoded frame's
  // body with the pinned canary SFrame. The cleartext VP8 prefix from the encoder is
  // discarded — the canary is the WHOLE outbound payload (a SHORT single-RTP-packet, 62B
  // ≪ MTU) so the FROZEN extractCanaryBody (rigid last-62) can recover it.
  let transformApi = null;
  const cipherSamples = []; // hex of the canary SFrames in strict CTRS order (relay-internal proof)
  const sender = producer.rtpSender;
  if (!sender) throw new Error('no RTCRtpSender on the producer (insertable streams need one)');
  // Mask the standard API UNCONDITIONALLY so the SHIPPED createEncodedStreams branch runs.
  try { delete window.RTCRtpScriptTransform; } catch { /* best-effort */ }

  const detectedApi = (typeof sender.createEncodedStreams === 'function') ? 'createEncodedStreams' : 'unsupported';
  if (detectedApi !== 'createEncodedStreams') {
    throw new Error('insertable streams (createEncodedStreams) unavailable on this sender — cannot inject canary');
  }
  transformApi = detectedApi;

  // Strict CTRS [0..7] order, once each then repeat (mirrors node-canary-producer bodies[frame % N]).
  let idx = 0;
  const { readable, writable } = sender.createEncodedStreams();
  const canaryStream = new TransformStream({
    async transform(frame, controller) {
      const ctr = OPTS.ctrs[idx % OPTS.ctrs.length];
      const sframe = await buildCanaryFrame({
        kRoom: OPTS.kRoom,
        roomId: OPTS.roomId,
        cellSecret: OPTS.cellSecret,
        canaryKid: OPTS.canaryKid,
        ctr,
      });
      // Capture one sample per distinct ctr, in CTRS order, under the raised cap.
      if (cipherSamples.length < OPTS.ctrs.length) {
        let hex = '';
        for (let i = 0; i < sframe.length; i++) hex += sframe[i].toString(16).padStart(2, '0');
        cipherSamples.push(hex);
      }
      idx++;
      frame.data = sframe.slice().buffer;
      controller.enqueue(frame);
    },
  });
  readable.pipeThrough(canaryStream).pipeTo(writable).catch((err) => {
    console.log('[m2b-canary] canary inject pipe failed ' + String(err));
  });
  console.log('[m2b-canary] canary inject attached (createEncodedStreams) canaryKid=' + OPTS.canaryKid);

  // Let RTP flow so the relay-internal tap captures a window of forwarded packets.
  await new Promise((r) => setTimeout(r, 4000));

  const stats = await producer.getStats();
  let outbound = null;
  stats.forEach((s) => { if (s.type === 'outbound-rtp') outbound = s; });
  console.log('[m2b-canary] producer outbound-rtp bytesSent=' + (outbound && outbound.bytesSent));

  return {
    ok: true,
    producerId,
    trackLabel: track.label,
    transformApi,
    canaryKid: OPTS.canaryKid,
    // hex of the canary SFrames the relay receives (in strict CTRS order) — the Node side
    // asserts byte-identity vs recomputeCanaryFrame and tail-survival vs the forwarded tap.
    cipherSamples,
    outboundBytesSent: outbound ? outbound.bytesSent : 0,
    connectionState: sendTransport.connectionState,
  };
}

// Expose to Playwright: it sets window.__canaryOpts then calls window.__canaryRun().
window.__canaryRun = () => {
  window.__canaryResult = run(window.__canaryOpts).catch((e) => {
    console.log('[m2b-canary] ERROR ' + (e && e.stack ? e.stack : String(e)));
    return { ok: false, error: String(e && e.message ? e.message : e) };
  });
  return window.__canaryResult;
};

console.log('[m2b-canary] entry loaded; mediasoup-client + real client crypto ready');
