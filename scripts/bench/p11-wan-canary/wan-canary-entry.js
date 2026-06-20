/**
 * P11 — WAN/real-camera canary-loss demo — browser-side entry (esbuild-bundled).
 *
 * ⚠️ DEFERRED RUN (REQ-CFA-034). This is the page the headless Chrome under test loads at a
 * viva/M4 milestone. It is NOT run during M3 (port lock + net-new media plane). See the
 * Node harness header (`p11-wan-canary-loss.ts`) + `P11-WAN-CANARY-RUNBOOK.md`.
 *
 * THE P10 → P11 DELTA:
 *   - P10 used Chrome's FAKE device (--use-fake-device-for-media-stream). P11 uses a REAL
 *     camera: getUserMedia({ video: true }) with NO fake-device flag. That is the only
 *     media change — everything else (real WebRtcTransport, real ICE/DTLS, the SHIPPED
 *     createEncodedStreams insertable-streams pipe, the SHIPPED `encryptFrame`) is the same
 *     production path P10 exercises.
 *   - P11 ALSO emits the DETERMINISTIC CANARY SFrame stream on the SAME insertable-streams
 *     pipe, INTERLEAVED with the real camera frames, so the validator-daemon's SHIPPED
 *     `verifyForwardedCanary` + `classifyDivergences` can run over a REAL lossy RTP path.
 *     The canary plaintext/keying are the SHIPPED validator-daemon derivation
 *     (`deriveCanarySeed`/`canaryPlaintext` from verifier.ts, recomputed here from
 *     cellSecret) → the SHIPPED client `encryptFrame` over the partial-SFrame layout. The
 *     canary body is a FIXED CANARY_SFRAME_LEN so the verifier's fixed-tail extraction
 *     locates it. NOTHING is reimplemented.
 *
 * SINGLE HOP: this page is the ONE publisher; the Node side co-homes the tap consumer on the
 * SAME relay. No second relay (W-E5).
 *
 * NEVER logs cellSecret / canary plaintext / K_canary / any key. The cellSecret is passed in
 * via window.__p11Opts (hex) ONLY so the page can recompute the same canary stream the
 * verifier expects — it is the out-of-band Wallet-B secret, never put on the RTP wire.
 */

import { Device } from 'mediasoup-client';
import { encryptFrame, codecOffsetForFrameType } from '../../../../dvconf-client/src/lib/webrtc/sframe-transform.ts';
import { KeyManager } from '../../../../dvconf-client/src/lib/crypto/key-manager.ts';
import { createSessionKeypair } from '../../../../dvconf-client/src/lib/crypto/session-keypair.ts';
// SHIPPED canary plaintext PRF + seed derivation (validator-daemon, recomputed here so the
// page's canary stream is byte-identical to what the verifier recomputes locally). These are
// pure functions over cellSecret — no key material is logged.
import {
  deriveCanarySeed,
  canaryPlaintext,
  CANARY_FRAME_LEN,
} from '../../../apps/validator-daemon/src/canary/verifier.ts';

const CANARY_KID = 0xca; // a fixed canary kid for the demo (matches the Node verifyInput).

/** Build REAL keying (mirrors P10 `realKeying`) → MY per-sender K_content + kid. */
async function realKeying(roomId) {
  const me = createSessionKeypair({ withOpener: true });
  const other = createSessionKeypair({ withOpener: true });
  const roster = [
    { peerId: 'peer-me', sessionPubkeyB64: me.publicKeyB64 },
    { peerId: 'peer-other', sessionPubkeyB64: other.publicKeyB64 },
  ];
  const meKm = new KeyManager({ roomId, localSessionPubkeyB64: me.publicKeyB64, opener: me.opener, graceWindowMs: 2000 });
  const otherKm = new KeyManager({ roomId, localSessionPubkeyB64: other.publicKeyB64, opener: other.opener, graceWindowMs: 2000 });
  meKm.setRoster(roster);
  otherKm.setRoster(roster);
  if (meKm.isCoordinator()) {
    const bundle = await meKm.bootstrapRoomKey();
    await otherKm.applyBundle(bundle);
  } else {
    const bundle = await otherKm.bootstrapRoomKey();
    await meKm.applyBundle(bundle);
  }
  const senderId = me.publicKeyB64;
  const kid = meKm.kid;
  const kContent = await meKm.contentKeyForSenderAtKid(senderId, kid);
  if (!kContent) throw new Error('realKeying: no K_content for the bootstrapped epoch');
  // RUNBOOK-TIME WIRING TODO (live run only): the validator-daemon verifier needs `kRoom`
  // (the room key, NOT a per-sender content key) in its VerifyInput. `KeyManager` does NOT
  // currently expose a `kRoom`/`roomKeyHex` getter (verified: its public surface is `kid` /
  // `contentKeyForSenderAtKid` / `keyLookupForSender`), so exporting kRoom to the Node side
  // is part of the deferred live-run wiring. The guard below returns null until then — the
  // demo verifier path is wired but kRoom plumbing is a viva/M4 TODO (see runbook §Open
  // wiring). The canary in this demo is encrypted with kContent + a fixed canaryKid, which
  // the Node verifyInput mirrors, so the demo is self-consistent without kRoom for the
  // canary leg; kRoom is only needed if the verifier re-derives K_canary on the Node side.
  const kRoomHex = typeof meKm.roomKeyHex === 'function' ? meKm.roomKeyHex() : null;
  return { senderId, kid, kContent, kRoomHex };
}

function makeRelayClient(url) {
  const ws = new WebSocket(url);
  const pending = [];
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + String(e))));
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
    for (let i = 0; i < pending.length; i++) {
      if (pending[i].predicate(msg)) { const [m] = pending.splice(i, 1); m.resolve(msg); return; }
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
  const { relayUrl, roomId, cellSecretHex } = opts;
  console.log('[p11-wan-canary] start relayUrl=' + relayUrl + ' room=' + roomId);

  // 1. REAL camera (NO fake device flag on the launcher → a real getUserMedia track).
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  const track = stream.getVideoTracks()[0];
  console.log('[p11-wan-canary] getUserMedia (REAL camera) ok track=' + track.label);

  // 2. REAL keying + recompute the deterministic canary plaintext stream from cellSecret.
  const keying = await realKeying(roomId);
  const cellSecret = hexToBytes(cellSecretHex);
  const canarySeed = deriveCanarySeed(cellSecret);
  console.log('[p11-wan-canary] keying ready kid=' + keying.kid);

  // 3. Relay handshake.
  const client = makeRelayClient(relayUrl);
  await client.ready;
  client.send({ type: 'join', roomId });
  const caps = await client.waitFor((m) => m.type === 'routerRtpCapabilities');

  // 4. Device + send transport (real WebRtcTransport, real ICE/DTLS; insertable streams on).
  const device = new Device();
  await device.load({ routerRtpCapabilities: caps.rtpCapabilities });
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
    try { client.send({ type: 'connectTransport', transportId: sendTransport.id, dtlsParameters }); callback(); }
    catch (err) { errback(err); }
  });
  let producerId = null;
  sendTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
    (async () => {
      try {
        client.send({ type: 'produce', transportId: sendTransport.id, kind, rtpParameters });
        const produced = await client.waitFor((m) => m.type === 'produced');
        producerId = produced.producerId;
        callback({ id: produced.producerId });
      } catch (err) { errback(err); }
    })().catch(errback);
  });

  // 5. Produce the REAL camera track.
  const producer = await sendTransport.produce({
    track,
    encodings: [{ maxBitrate: 1_000_000 }],
    codecOptions: { videoGoogleStartBitrate: 1000 },
  });
  console.log('[p11-wan-canary] produced producerId=' + producer.id);

  // 6. Own the insertable-streams pipe. REPLACE each Nth real frame's body with a
  // DETERMINISTIC CANARY SFrame (the covert-publisher pattern: the canary rides the SAME
  // media stream, indistinguishable on the wire). The canary uses the SHIPPED `encryptFrame`
  // over the canary key — here, for the demo, the canary is encrypted with kContent and a
  // FIXED canaryKid + monotonic ctr so the verifier's fixed-tail extraction + recompute
  // locates it. expectedCtrs records exactly which ctrs were emitted as canaries.
  const sender = producer.rtpSender;
  if (!sender) throw new Error('no RTCRtpSender (insertable streams need one)');
  try { delete window.RTCRtpScriptTransform; } catch { /* best-effort */ }
  const { readable, writable } = sender.createEncodedStreams();
  const expectedCtrs = [];
  let canaryCtr = 0;
  const CANARY_EVERY = Number(opts.canaryEvery ?? 10); // 1 canary per N real frames.
  let frameIdx = 0;
  const sframeStream = new TransformStream({
    async transform(frame, controller) {
      frameIdx++;
      if (frameIdx % CANARY_EVERY === 0) {
        // Emit a CANARY frame: deterministic plaintext P_i from cellSecret, encrypted with
        // the SHIPPED `encryptFrame` over a pinned codecOffset so the body is a FIXED
        // CANARY_SFRAME_LEN the verifier extracts from the tail.
        const ctr = canaryCtr++;
        const pt = canaryPlaintext(canarySeed, ctr); // SHIPPED PRF; never logged.
        const codecOffset = codecOffsetForFrameType('key', pt.length); // pinned (>= offset).
        const sframe = await encryptFrame(pt, { kid: CANARY_KID, ctr }, keying.kContent, codecOffset);
        expectedCtrs.push(ctr);
        frame.data = sframe.slice().buffer;
        controller.enqueue(frame);
      } else {
        // pass the real camera frame through unmodified (it is the cover traffic).
        controller.enqueue(frame);
      }
    },
  });
  readable.pipeThrough(sframeStream).pipeTo(writable).catch((err) => {
    console.log('[p11-wan-canary] sender pipe failed ' + String(err));
  });
  console.log('[p11-wan-canary] canary stream attached (1 per ' + CANARY_EVERY + ' real frames) kid=' + CANARY_KID);

  // 7. Let RTP flow so the lossy tap captures a window.
  await new Promise((r) => setTimeout(r, 5000));

  return {
    ok: true,
    roomId,
    producerId,
    trackLabel: track.label,
    canaryKid: CANARY_KID,
    kid: keying.kid,
    kRoomHex: keying.kRoomHex,
    expectedCtrs,
    connectionState: sendTransport.connectionState,
  };
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

window.__p11Run = () => {
  window.__p11Result = run(window.__p11Opts).catch((e) => {
    console.log('[p11-wan-canary] ERROR ' + (e && e.stack ? e.stack : String(e)));
    return { ok: false, error: String(e && e.message ? e.message : e) };
  });
  return window.__p11Result;
};

console.log('[p11-wan-canary] entry loaded; mediasoup-client + real client crypto + canary PRF ready');
void CANARY_FRAME_LEN; // referenced for parity with the verifier's frame length.
