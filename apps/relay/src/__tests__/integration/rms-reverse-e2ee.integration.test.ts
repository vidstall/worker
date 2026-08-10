/**
 * REQ-RMS-038 (part-3 Stage R-C) -- HERMETIC E2EE 2-HOP FIDELITY + FAIL-CLOSED-ON-
 * DELIVERY, proven on REAL mediasoup across the reverse hub path
 *   standby-A's client  ->  PRIMARY hub  ->  far standby-C.
 *
 * See rms-reverse-e2ee.fixtures.ts for the full methodology narrative ("what is
 * asserted" / "not a tautology" / real-mediasoup notes) and the shared harness
 * (startSignaling/joinClient/waitForFan, buildSframes/makeSframeVp8SourceOn/
 * driveAndAssertByteId) this file drives.
 *
 * Run:
 *   pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *     apps/relay/src/__tests__/integration/rms-reverse-e2ee.integration.test.ts
 *   P10 RED hook:  $env:P10_FORCE_TAMPER='1'; <that command>  => MUST FAIL
 *
 * Requirements touched: REQ-RMS-038 (E2EE fail-closed) + REQ-RMS-029 (publisher binding)
 * + REQ-RMS-026 (SSRC remap, implicit in the pipe) + REQ-MCS-014 (relay-blind SFrame).
 */

import { describe, it, expect } from 'vitest';
import {
  InterRelayProducerRegistry,
  createInterRelayAnnouncer,
  isPipeProducerAnnounce,
  pipeRoomToSecondWorker,
  type InterRelaySocketLike,
} from '@dvconf/inter-relay-client';
import type { InterRelayContext } from '../../signaling/index.js';
import { createInterRelaySocketMap } from '../../inter-relay-socket-map.js';
import {
  mediaCodecs,
  primaryWorker,
  workerC,
  managerWithRealRouter,
  startSignaling,
  joinClient,
  waitForFan,
  buildSframes,
  makeSframeVp8SourceOn,
  driveAndAssertByteId,
  ORIGIN_RELAY,
  CASCADE_RELAY,
  HUB_RELAY,
  PUBLISHER,
  openClients,
  openServers,
  openRouters,
  sleep,
} from './rms-reverse-e2ee.fixtures.js';

describe('REQ-RMS-038 — R-C hermetic E2EE 2-hop fidelity + fail-closed-on-delivery (real mediasoup)', () => {
  it('(a)+(d) E2EE, publisher-id PRESENT: binding survives BOTH hops + REAL SFrame byte-identical primary→C (P10 RED hook = teeth)', async () => {
    const roomId = 'rms-rc-e2ee-present';
    const ctx = await buildSframes();

    const primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
    const routerC = await workerC.createRouter({ mediaCodecs });
    openRouters.push(primaryRouter, routerC);

    // ── HUB (primary) server: E2EE room + ONE joined local client + the socket map the
    //    hub-fan loop iterates (origin + cascade attached). ──
    const hubRegistry = new InterRelayProducerRegistry();
    const onPrimaryProducerCalls: Array<{ peerRelayId?: string; producerPeerId?: string; producerId: string }> = [];
    const hubInterRelay: InterRelayContext = {
      role: 'primary',
      registry: hubRegistry,
      announceProducer: () => {},
      onPrimaryProducer: (_rid, _router, producer, peerRelayId, producerPeerId) => {
        onPrimaryProducerCalls.push({ peerRelayId, producerPeerId, producerId: producer.id });
      },
    };
    const hubSockets = createInterRelaySocketMap();
    const stub = (): InterRelaySocketLike => ({ readyState: 1, send: () => {} });
    hubSockets.attach(ORIGIN_RELAY, stub());
    hubSockets.attach(CASCADE_RELAY, stub());
    const { server: hubServer, port: hubPort } = await startSignaling(
      hubInterRelay, managerWithRealRouter(primaryRouter), hubSockets,
    );
    openServers.push(hubServer.wss);
    const hub = await joinClient(hubPort, roomId, 'hub-listener', { e2ee: true, seed: 1 });
    openClients.push(hub.ws);

    // ── Far standby C server: SAME E2EE room + ONE joined local client. Its OWN shipped
    //    fanLocalProducer gate is the C-side delivery seam. ──
    const cRegistry = new InterRelayProducerRegistry();
    const cInterRelay: InterRelayContext = { role: 'standby', registry: cRegistry, announceProducer: () => {} };
    const { server: cServer, port: cPort } = await startSignaling(
      cInterRelay, managerWithRealRouter(routerC), createInterRelaySocketMap(),
    );
    openServers.push(cServer.wss);
    const c = await joinClient(cPort, roomId, 'c-listener', { e2ee: true, seed: 2 });
    openClients.push(c.ws);

    // ── The reverse-minted hub copy: a REAL VP8 SFrame producer on the primary room.router. ──
    const minted = await makeSframeVp8SourceOn(primaryRouter, ctx.sframes);

    // The hub RECEIVED standby-A's reverse UP-announce carrying producerPeerId='clientA'
    // (driven through the REAL announce wire — proves the binding survives serialization).
    // In production, produceLocalFromPipe mints id === announced.id (rms-reverse-leg), so the
    // hub copy's id IS the announced id; the test models that by announcing minted.producer.id
    // directly (no produceLocalFromPipe here — `minted` is a fresh real producer), so
    // resolveByProducerId(minted.id) returns the ORIGINAL publisher.
    const recordIntoHub = createInterRelayAnnouncer({
      send: (data) => { const p = JSON.parse(data) as unknown; if (isPipeProducerAnnounce(p)) hubRegistry.record(p); },
    });
    recordIntoHub(roomId, { id: minted.producer.id, kind: 'video' }, PUBLISHER, ORIGIN_RELAY);

    // ── DRIVE THE REAL HUB SEAM: registerReverseMinted fans LOCAL (gate present-id ⇒ fan)
    //    + hub-fans DOWN to the non-origin standby (onPrimaryProducer), excludes origin. ──
    hubServer.registerReverseMinted(roomId, minted.producer, ORIGIN_RELAY, PUBLISHER);

    // (delivery on the PRIMARY) the hub's local client got the producer bound to the
    // ORIGINAL publisher 'clientA' — NEVER the origin relayId.
    const hubFan = await waitForFan(hub.fans, minted.producer.id);
    expect(hubFan, 'E2EE present-id MUST fan to the primary local client').toBeDefined();
    expect(hubFan!['peerId']).toBe(PUBLISHER);
    expect(hubFan!['peerId']).not.toBe(ORIGIN_RELAY);

    // the hub-fan onPrimaryProducer fired for the non-origin standby, never the origin.
    const calledPeers = onPrimaryProducerCalls.map((x) => x.peerRelayId);
    expect(calledPeers).toContain(CASCADE_RELAY);
    expect(calledPeers).not.toContain(ORIGIN_RELAY);
    expect(onPrimaryProducerCalls.find((x) => x.peerRelayId === CASCADE_RELAY)!.producerPeerId).toBe(PUBLISHER);

    // ── C-SIDE forward + delivery: pipe the hub copy DOWN to routerC ONCE (reused for
    //    both the C fan and the byte-id capture), record C's DOWN announce (REAL wire),
    //    and fan via C's OWN shipped fanLocalProducer. ──
    const { pipeProducer } = await pipeRoomToSecondWorker(primaryRouter, routerC, minted.producer.id);
    const recordIntoC = createInterRelayAnnouncer({
      send: (data) => { const p = JSON.parse(data) as unknown; if (isPipeProducerAnnounce(p)) cRegistry.record(p); },
    });
    recordIntoC(roomId, { id: pipeProducer.id, kind: 'video' }, PUBLISHER, HUB_RELAY);
    cServer.fanLocalProducer(roomId, PUBLISHER, pipeProducer, HUB_RELAY);

    const cFan = await waitForFan(c.fans, pipeProducer.id);
    expect(cFan, 'E2EE present-id MUST fan to the far-standby local client').toBeDefined();
    expect(cFan!['peerId']).toBe(PUBLISHER);
    expect(cFan!['peerId']).not.toBe(HUB_RELAY);

    // ── ASSERTION (a): publisher-id survives BOTH hops in the registry (NEVER a relayId). ──
    const hubRec = hubRegistry.resolveByProducerId(roomId, minted.producer.id);
    const cRec = cRegistry.resolveByProducerId(roomId, pipeProducer.id);
    expect(hubRec?.producerPeerId).toBe(PUBLISHER);
    expect(hubRec?.producerPeerId).not.toBe(ORIGIN_RELAY);
    expect(cRec?.producerPeerId).toBe(PUBLISHER);
    expect(cRec?.producerPeerId).not.toBe(HUB_RELAY);
    expect(cRec?.producerPeerId).not.toBe(CASCADE_RELAY);

    // ── ASSERTION (d): REAL SFrame ciphertext is byte-identical across the 2nd hop
    //    (primary→C, reusing the pipeProducer above); P10_FORCE_TAMPER flips a body byte
    //    → byteIdentical < mediaPackets. ──
    await driveAndAssertByteId(minted, routerC, pipeProducer, ctx, 'e2ee-present-2hop');

    try { minted.producer.close(); } catch { /* best-effort */ }
  }, 60_000);

  it('(b) E2EE, publisher-id MISSING: NOT-DELIVERED on the primary AND on C (gate), while the hub-fan onPrimaryProducer STILL fired (delivery, not mint)', async () => {
    const roomId = 'rms-rc-e2ee-missing';

    const primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
    const routerC = await workerC.createRouter({ mediaCodecs });
    openRouters.push(primaryRouter, routerC);

    const onPrimaryProducerCalls: Array<{ peerRelayId?: string; producerPeerId?: string }> = [];
    const hubInterRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: () => {},
      onPrimaryProducer: (_rid, _router, _producer, peerRelayId, producerPeerId) => {
        onPrimaryProducerCalls.push({ peerRelayId, producerPeerId });
      },
    };
    const hubSockets = createInterRelaySocketMap();
    const stub = (): InterRelaySocketLike => ({ readyState: 1, send: () => {} });
    hubSockets.attach(ORIGIN_RELAY, stub());
    hubSockets.attach(CASCADE_RELAY, stub());
    const { server: hubServer, port: hubPort } = await startSignaling(
      hubInterRelay, managerWithRealRouter(primaryRouter), hubSockets,
    );
    openServers.push(hubServer.wss);
    const hub = await joinClient(hubPort, roomId, 'hub-listener', { e2ee: true, seed: 1 });
    openClients.push(hub.ws);

    const cInterRelay: InterRelayContext = {
      role: 'standby', registry: new InterRelayProducerRegistry(), announceProducer: () => {},
    };
    const { server: cServer, port: cPort } = await startSignaling(
      cInterRelay, managerWithRealRouter(routerC), createInterRelaySocketMap(),
    );
    openServers.push(cServer.wss);
    const c = await joinClient(cPort, roomId, 'c-listener', { e2ee: true, seed: 2 });
    openClients.push(c.ws);

    // A reverse-minted producer with NO original publisher id (a pre-mesh / publisher-less
    // cross-relay frame). No media needs to flow — fail-closed is a DELIVERY decision.
    const minted = await makeSframeVp8SourceOn(primaryRouter, [new Uint8Array([1, 2, 3, 4])]);

    // HUB: registerReverseMinted with producerPeerId=undefined in an E2EE room.
    hubServer.registerReverseMinted(roomId, minted.producer, ORIGIN_RELAY, undefined);

    // C: pipe DOWN (the coordinator forwards transport-level, no e2ee context) + fan via
    // C's OWN shipped fanLocalProducer with the RAW (undefined) producerPeerId.
    const { pipeProducer } = await pipeRoomToSecondWorker(primaryRouter, routerC, minted.producer.id);
    cServer.fanLocalProducer(roomId, undefined, pipeProducer, HUB_RELAY);

    await sleep(200); // give any (incorrect) fan a chance to land before asserting absence

    // ── (b) NOT-DELIVERED — the gate suppresses delivery at BOTH hops. ──
    expect(
      hub.fans.find((m) => m['producerId'] === minted.producer.id),
      'E2EE missing-id MUST NOT be delivered to the primary local client',
    ).toBeUndefined();
    expect(
      c.fans.find((m) => m['producerId'] === pipeProducer.id),
      'E2EE missing-id MUST NOT be delivered to the far-standby local client',
    ).toBeUndefined();

    // ── CRITICAL framing: the hub-fan onPrimaryProducer DID FIRE for the non-origin
    //    standby (the coordinator has no e2ee context — it forwards transport-level).
    //    The producer MAY have been minted/forwarded; suppression is on DELIVERY only. ──
    const calledPeers = onPrimaryProducerCalls.map((x) => x.peerRelayId);
    expect(calledPeers).toContain(CASCADE_RELAY);
    expect(calledPeers).not.toContain(ORIGIN_RELAY);
    // eslint-disable-next-line no-console
    console.log(
      `[REQ-RMS-038 e2ee-missing] hubDelivered=${hub.fans.some((m) => m['producerId'] === minted.producer.id)} ` +
        `cDelivered=${c.fans.some((m) => m['producerId'] === pipeProducer.id)} ` +
        `hubFanFiredForC=${calledPeers.includes(CASCADE_RELAY)} (fail-closed = NOT-DELIVERED, not never-minted)`,
    );

    // ── POSITIVE CONTROL (proves the absence above is real suppression, not a dead/slow
    //    listener): fan a PRESENT-id producer through the SAME shipped path to BOTH e2ee
    //    servers and confirm it DOES land on both clients within waitForFan's ~2000ms (the
    //    same delivery bound case (a) relies on). A distinct SSRC lets it coexist with the
    //    missing-id producer on primaryRouter. No media leg here ⇒ P10-insensitive (so (b)
    //    stays GREEN under P10_FORCE_TAMPER). ──
    const PRESENT = 'clientPresent';
    const present = await makeSframeVp8SourceOn(primaryRouter, [new Uint8Array([5, 6, 7, 8])], 0x7000_0010);
    hubServer.registerReverseMinted(roomId, present.producer, ORIGIN_RELAY, PRESENT);
    const { pipeProducer: presentPipe } = await pipeRoomToSecondWorker(primaryRouter, routerC, present.producer.id);
    cServer.fanLocalProducer(roomId, PRESENT, presentPipe, HUB_RELAY);

    const hubPresentFan = await waitForFan(hub.fans, present.producer.id);
    const cPresentFan = await waitForFan(c.fans, presentPipe.id);
    expect(hubPresentFan, 'positive control: present-id MUST deliver to the primary client (channel live + fast)').toBeDefined();
    expect(hubPresentFan!['peerId']).toBe(PRESENT);
    expect(cPresentFan, 'positive control: present-id MUST deliver to the far-standby client (channel live + fast)').toBeDefined();
    expect(cPresentFan!['peerId']).toBe(PRESENT);

    try { minted.producer.close(); present.producer.close(); } catch { /* best-effort */ }
  }, 60_000);

  it('(c)+(d) OPEN room, publisher-id MISSING: graceful fallback DELIVERS (bound to relayId) byte-stable — proves the gate is E2EE-scoped (P10 RED hook)', async () => {
    const roomId = 'rms-rc-open-missing';
    const ctx = await buildSframes();

    const primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
    const routerC = await workerC.createRouter({ mediaCodecs });
    openRouters.push(primaryRouter, routerC);

    const hubSockets = createInterRelaySocketMap();
    const stub = (): InterRelaySocketLike => ({ readyState: 1, send: () => {} });
    hubSockets.attach(ORIGIN_RELAY, stub());
    hubSockets.attach(CASCADE_RELAY, stub());
    const hubInterRelay: InterRelayContext = {
      role: 'primary', registry: new InterRelayProducerRegistry(), announceProducer: () => {},
      onPrimaryProducer: () => {},
    };
    const { server: hubServer, port: hubPort } = await startSignaling(
      hubInterRelay, managerWithRealRouter(primaryRouter), hubSockets,
    );
    openServers.push(hubServer.wss);
    // OPEN room: legacy join with NO roomPassword ⇒ no roomConfigs entry ⇒ e2ee=false.
    const hub = await joinClient(hubPort, roomId, 'hub-listener', { e2ee: false, seed: 1 });
    openClients.push(hub.ws);

    const minted = await makeSframeVp8SourceOn(primaryRouter, ctx.sframes);

    // The SAME missing-id scenario as (b), but in an OPEN room: the gate does NOT fire;
    // graceful fallback binds the fan to the cascade/origin relayId (byte-stable).
    hubServer.registerReverseMinted(roomId, minted.producer, ORIGIN_RELAY, undefined);

    const hubFan = await waitForFan(hub.fans, minted.producer.id);
    expect(hubFan, 'OPEN missing-id MUST still DELIVER (graceful fallback)').toBeDefined();
    expect(hubFan!['peerId']).toBe(ORIGIN_RELAY); // bound to the relayId (no publisher id present)

    // ── (d) the forwarded media is byte-stable across the 2nd hop (P10 RED hook = teeth). ──
    const { pipeProducer } = await pipeRoomToSecondWorker(primaryRouter, routerC, minted.producer.id);
    await driveAndAssertByteId(minted, routerC, pipeProducer, ctx, 'open-missing-2hop');

    try { minted.producer.close(); } catch { /* best-effort */ }
  }, 60_000);
});
