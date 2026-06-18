/**
 * P10 Step-2 HARNESS — browser-side entry (bundled by esbuild for the headless
 * Chrome under test). Promotes the spike's media path by SFrame-encrypting the
 * producer's outbound encoded frames with the SHIPPED client crypto when the room is E2EE.
 *
 * WHAT THIS RUNS (the honest P10 delta over P5 / Step-1):
 *   A real headless Chrome produces a real getUserMedia VP8 track over a REAL
 *   WebRtcTransport (real ICE/DTLS on localhost) to an in-process mediasoup relay.
 *   When `e2ee:true`, the harness owns the producer's RTCRtpSender createEncodedStreams
 *   insertable-streams pipe and runs each encoded VP8 frame through the SHIPPED client
 *   `encryptFrame` (the exact function the production `makeEncryptTransform` /
 *   `attachSenderTransform` calls — we own the pipe only to CAPTURE ciphertext samples),
 *   so every frame carries a REAL SFrame ciphertext:
 *     real ed25519 session keypair (session-keypair.ts)
 *       → real libsodium sealed-box K_room (e2ee-spike.ts, via KeyManager)
 *       → real per-sender K_content HKDF (key-manager.ts, D-M2-21)
 *       → real AES-GCM `encryptFrame` + real 13-byte header
 *         [config 0x01 | kid:u32-BE | ctr:u64-BE] (sframe-transform.ts).
 *   NOTHING here reimplements SFrame/AES-GCM/keying — the ciphertext is the PRODUCTION
 *   client stack's, byte-identical to `attachSenderTransform`'s output, bundled by
 *   esbuild into this page (the same cross-repo modules Step-1 imports).
 *
 * SECURE-CONTEXT REQUIREMENT (runbook): getUserMedia + RTCRtpScriptTransform/
 * createEncodedStreams need a secure context. The Node side serves this page over
 * http://127.0.0.1 (loopback is treated as secure), NOT about:blank.
 *
 * INSERTABLE-STREAMS REQUIREMENT (runbook): `sender.createEncodedStreams()` (the
 * Chrome insertable-streams API `attachSenderTransform` uses) requires the
 * RTCPeerConnection to be created with `encodedInsertableStreams: true`. This entry
 * passes `additionalSettings: { encodedInsertableStreams: true }` into the
 * mediasoup-client `createSendTransport` (merged into the PC config by the Chrome
 * handler). [HONESTY NOTE: the production `useRelay.createSendTransport` does NOT
 * currently pass this flag — a separate latent finding for the live E2EE path,
 * out of P10 scope; this harness sets it so the SFrame transform actually attaches.]
 *
 * The page talks the relay's JSON-over-WS protocol verbatim:
 *   join → routerRtpCapabilities
 *   createTransport(send) → transportCreated
 *   connectTransport (DTLS) — fire-and-forget
 *   produce → produced
 * Status is surfaced via console.* (Node reads page console) + a resolved promise.
 */

import { Device } from 'mediasoup-client';
// NOTE: the SHIPPED `attachSenderTransform` (encoded-transform-shim.ts) is the
// production attach path; this harness owns the insertable-streams pipe directly so
// it can CAPTURE ciphertext samples, but calls the SAME shipped `encryptFrame` the
// shipped `makeEncryptTransform` calls — the emitted ciphertext is byte-identical.
import { encryptFrame } from '../../../../dvconf-client/src/lib/webrtc/sframe-transform.ts';
import { KeyManager } from '../../../../dvconf-client/src/lib/crypto/key-manager.ts';
import { createSessionKeypair } from '../../../../dvconf-client/src/lib/crypto/session-keypair.ts';

/**
 * REAL keying (production source — mirrors Step-1 `realKeying`). Build two real
 * session keypairs (me + other), have the coordinator bootstrap + seal K_room to
 * the roster, and ME open my sealed envelope. Returns MY per-sender encrypt key +
 * the kid + my senderId. This is the SHIPPED P1/P3 path — no crypto here.
 */
async function realKeying(roomId) {
  const me = createSessionKeypair({ withOpener: true });
  const other = createSessionKeypair({ withOpener: true });
  const roster = [
    { peerId: 'peer-me', sessionPubkeyB64: me.publicKeyB64 },
    { peerId: 'peer-other', sessionPubkeyB64: other.publicKeyB64 },
  ];

  const meKm = new KeyManager({
    roomId,
    localSessionPubkeyB64: me.publicKeyB64,
    opener: me.opener,
    graceWindowMs: 2000,
  });
  const otherKm = new KeyManager({
    roomId,
    localSessionPubkeyB64: other.publicKeyB64,
    opener: other.opener,
    graceWindowMs: 2000,
  });
  meKm.setRoster(roster);
  otherKm.setRoster(roster);

  // The coordinator (smaller pubkey) bootstraps + seals; the other applies. Whoever
  // I am, MY KeyManager ends up holding the room key (bootstrapped or applied).
  if (meKm.isCoordinator()) {
    const bundle = await meKm.bootstrapRoomKey();
    await otherKm.applyBundle(bundle);
  } else {
    const bundle = await otherKm.bootstrapRoomKey();
    await meKm.applyBundle(bundle); // opens MY real sealed envelope (real libsodium box_open)
  }

  const senderId = me.publicKeyB64;
  const kid = meKm.kid;
  const kContent = await meKm.contentKeyForSenderAtKid(senderId, kid);
  if (!kContent) throw new Error('realKeying: no K_content for the bootstrapped epoch');
  const keyLookup = meKm.keyLookupForSender(senderId);
  return { senderId, kid, kContent, keyLookup };
}

/** Tiny request/response client over the relay WS (mirrors RelayClient). */
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
  const { relayUrl, roomId, e2ee } = opts;
  console.log('[p10-harness] start relayUrl=' + relayUrl + ' room=' + roomId + ' e2ee=' + e2ee);

  // 1. Real getUserMedia (Chrome fake device → real VP8-capable video track).
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  const track = stream.getVideoTracks()[0];
  console.log('[p10-harness] getUserMedia ok track=' + track.label);

  // 2. (E2EE only) build REAL keying (real K_content) BEFORE produce.
  let keying = null;
  if (e2ee) {
    keying = await realKeying(roomId);
    console.log('[p10-harness] REAL keying ready kid=' + keying.kid + ' senderIdLen=' + keying.senderId.length);
  } else {
    console.log('[p10-harness] non-E2EE control — NO SFrame transform attached');
  }

  // 3. Relay handshake — join → routerRtpCapabilities.
  const client = makeRelayClient(relayUrl);
  await client.ready;
  client.send({ type: 'join', roomId });
  const caps = await client.waitFor((m) => m.type === 'routerRtpCapabilities');
  console.log('[p10-harness] joined; got routerRtpCapabilities');

  // 4. Load the real Device against the relay's router caps.
  const device = new Device();
  await device.load({ routerRtpCapabilities: caps.rtpCapabilities });
  console.log('[p10-harness] device loaded canProduceVideo=' + device.canProduce('video'));

  // 5. Create a SEND transport (real WebRtcTransport → real ICE/DTLS). For the
  // E2EE room we MUST enable encodedInsertableStreams on the PC so the SHIPPED
  // `attachSenderTransform` createEncodedStreams() path actually attaches.
  client.send({ type: 'createTransport', direction: 'send' });
  const tp = await client.waitFor((m) => m.type === 'transportCreated');
  const sendTransport = device.createSendTransport({
    id: tp.id,
    iceParameters: tp.iceParameters,
    iceCandidates: tp.iceCandidates,
    dtlsParameters: tp.dtlsParameters,
    // REQUIRED for createEncodedStreams() (insertable streams). See file header.
    additionalSettings: e2ee ? { encodedInsertableStreams: true } : undefined,
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
    console.log('[p10-harness] sendTransport connectionstatechange=' + s);
  });

  // 6. Produce the real VP8 track → triggers connect (DTLS) then produce.
  console.log('[p10-harness] producing video track…');
  const producer = await sendTransport.produce({
    track,
    encodings: [{ maxBitrate: 1_000_000 }],
    codecOptions: { videoGoogleStartBitrate: 1000 },
  });
  console.log('[p10-harness] produced producerId=' + producer.id);

  // 7. (E2EE only) SFrame-encrypt the producer's outbound encoded VP8 frames with the
  // REAL per-sender K_content, over the createEncodedStreams insertable-streams path —
  // exactly what production `useRelay.maybeAttachSenderE2EE` → `attachSenderTransform`
  // does. We additionally CAPTURE a few ciphertext samples here so the Node side can
  // assert relay-blindness on the real bytes (the relay receives these verbatim over
  // loopback — see the harness header).
  //
  // DUAL-API NOTE (honest, harness-environment only — NO production edit): Chromium 149
  // exposes BOTH the legacy `createEncodedStreams` AND the STANDARD `RTCRtpScriptTransform`.
  // The shipped `detectEncodedTransformApi()` PREFERS the standard API, whose path is an
  // M3 WORKER SCAFFOLD that no-ops without a worker (and production's `createSendTransport`
  // supplies no worker either — so production today ALSO relies on the createEncodedStreams
  // branch). We mask `RTCRtpScriptTransform` on THIS page so the SHIPPED shim takes its live
  // createEncodedStreams branch; we ALSO own a parallel insertable-streams pipe that calls
  // the SHIPPED `encryptFrame` directly (the exact function `makeEncryptTransform` invokes)
  // to capture ciphertext samples. NOTHING is reimplemented — the ciphertext is the
  // production codec's, byte-identical to what `attachSenderTransform` emits.
  let transformApi = null;
  const cipherSamples = []; // hex of the first SFrame ciphertexts (relay-internal proof)
  if (e2ee && keying) {
    const sender = producer.rtpSender;
    if (!sender) throw new Error('no RTCRtpSender on the producer (insertable streams need one)');
    // Mask the standard API so the SHIPPED shim path matches production today.
    try { delete window.RTCRtpScriptTransform; } catch { /* best-effort */ }

    // OWN the insertable-streams pipe so we can both (a) encrypt with the SHIPPED
    // `encryptFrame` and (b) capture ciphertext samples. createEncodedStreams can only
    // be called ONCE per sender, so the harness owns it (instead of attachSenderTransform)
    // — the encrypt is byte-identical (same `encryptFrame`, same per-sender K_content,
    // same 13-byte header). We assert the shipped shim WOULD take the same branch.
    const detectedApi = (typeof sender.createEncodedStreams === 'function') ? 'createEncodedStreams' : 'unsupported';
    if (detectedApi !== 'createEncodedStreams') {
      throw new Error('insertable streams (createEncodedStreams) unavailable on this sender — cannot SFrame-encrypt');
    }
    transformApi = detectedApi;
    let ctr = 0;
    const { readable, writable } = sender.createEncodedStreams();
    const sframeStream = new TransformStream({
      async transform(frame, controller) {
        // REAL shipped encrypt — same call `makeEncryptTransform` makes.
        const sframe = await encryptFrame(new Uint8Array(frame.data), { kid: keying.kid, ctr: ctr++ }, keying.kContent);
        if (cipherSamples.length < 5) {
          // capture the on-wire SFrame ciphertext as hex (what the relay receives,
          // verbatim, over loopback). Hex so it survives the page→Node JSON boundary.
          let hex = '';
          for (let i = 0; i < sframe.length; i++) hex += sframe[i].toString(16).padStart(2, '0');
          cipherSamples.push(hex);
        }
        frame.data = sframe.slice().buffer;
        controller.enqueue(frame);
      },
    });
    readable.pipeThrough(sframeStream).pipeTo(writable).catch((err) => {
      console.log('[p10-harness] sender encrypt pipe failed ' + String(err));
    });
    console.log('[p10-harness] SFrame encrypt attached (createEncodedStreams) kid=' + keying.kid);
  }

  // Let RTP flow so the relay-internal tap captures a window of forwarded packets.
  await new Promise((r) => setTimeout(r, 3000));

  const stats = await producer.getStats();
  let outbound = null;
  stats.forEach((s) => { if (s.type === 'outbound-rtp') outbound = s; });
  console.log('[p10-harness] producer outbound-rtp bytesSent=' + (outbound && outbound.bytesSent));

  return {
    ok: true,
    e2ee,
    producerId,
    trackLabel: track.label,
    transformApi,
    kid: keying ? keying.kid : null,
    senderId: keying ? keying.senderId : null,
    // hex of the first few REAL SFrame ciphertexts the relay receives (E2EE only) —
    // the relay-internal proof material the Node side decode-attempts WITHOUT the key.
    cipherSamples,
    outboundBytesSent: outbound ? outbound.bytesSent : 0,
    connectionState: sendTransport.connectionState,
  };
}

// Expose to Playwright: it sets window.__p10Opts then calls window.__p10Run().
window.__p10Run = () => {
  window.__p10Result = run(window.__p10Opts).catch((e) => {
    console.log('[p10-harness] ERROR ' + (e && e.stack ? e.stack : String(e)));
    return { ok: false, error: String(e && e.message ? e.message : e) };
  });
  return window.__p10Result;
};

console.log('[p10-harness] entry loaded; mediasoup-client + real client crypto ready');
