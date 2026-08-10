/**
 * G3.2b — inter-relay re-fan-on-attach + standby UP re-announce (REQ-RMS-037,
 * Task B4b).
 *
 * Mocked MediasoupManager (real mediasoup workers gated to the relay-integration
 * suite). Requirements: REQ-RO-004 (G1) · G3 (cross-daemon WS wiring + auth).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { WebSocketServer } from 'ws';
import type { InterRelayContext } from '../signaling/index.js';
import { InterRelayProducerRegistry } from '@dvconf/inter-relay-client';
import {
  startServer,
  connectPlain,
  connectInterRelay,
  sendAndAwait,
  tick,
} from './inter-relay-auth-wiring.fixtures.js';

let server: WebSocketServer | undefined;
afterEach(() => {
  if (server) { server.close(); server = undefined; }
});

describe('inter-relay re-fan-on-attach + standby UP re-announce (REQ-RMS-037, Task B4b)', () => {
  it('RED-RB-4a: a primary re-fans existing producers DOWN to a NEWLY-attached standby ONLY (no re-broadcast to synced peers)', async () => {
    const onPrimaryProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onPrimaryProducer,
      attachPeerSocket: vi.fn(),
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    // An untagged client joins + produces BEFORE any standby attaches.
    const client = await connectPlain(port);
    await sendAndAwait(client, { type: 'join', roomId: 'roomA', peerId: 'clientP' }, 'routerRtpCapabilities');
    const created = await sendAndAwait(client, { type: 'createTransport', direction: 'send' }, 'transportCreated');
    await sendAndAwait(
      client,
      { type: 'produce', transportId: created.id, kind: 'video', rtpParameters: { codecs: [], headerExtensions: [] } },
      'produced',
    );
    await tick();

    // The pre-attach produce fanned ONE legacy (empty-keys) call (c[3] === undefined);
    // clear it so we count ONLY the re-fan to the newly-attached peer.
    onPrimaryProducer.mockClear();

    // NOW a standby attaches as a TAGGED inter-relay peer (Bearer + peerRelayId header).
    const standby = await connectInterRelay(port, 'relay-secret', 'ws://standbyB');
    await tick();

    // Exactly ONE re-fan, to JUST standbyB (4th arg = peerRelayId), carrying the
    // original local publisher (clientP) as the 5th arg — NOT a re-broadcast.
    const calls = onPrimaryProducer.mock.calls.filter((c) => c[3] === 'ws://standbyB');
    expect(calls.length).toBe(1);
    expect(calls[0]![4]).toBe('clientP');

    client.close();
    standby.close();
  });

  it('RED-RB-4b: reannounceLocalProducersUp re-drives a standby local producer UP (link-reopen back-fill capability)', async () => {
    // 3b ships the back-fill as a CAPABILITY (factory fn + late-bind). Its automatic
    // trigger on link reopen has no clean per-room seam — the standby link is single-
    // box / per-daemon and its open event is owned by inter-relay-link.ts — so the
    // reopen back-fill is covered structurally by RED-RA-2b (the A2 reverse queue
    // back-fills pre-connect producers). This asserts the capability the wiring would
    // invoke. RED today: reannounceLocalProducersUp does not exist on the factory.
    const onStandbyProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onStandbyProducer,
    };
    const { wss, port, factory } = await startServer(interRelay); // token unset
    server = wss;

    const client = await connectPlain(port);
    await sendAndAwait(client, { type: 'join', roomId: 'roomS', peerId: 'clientS' }, 'routerRtpCapabilities');
    const created = await sendAndAwait(client, { type: 'createTransport', direction: 'send' }, 'transportCreated');
    await sendAndAwait(
      client,
      { type: 'produce', transportId: created.id, kind: 'video', rtpParameters: { codecs: [], headerExtensions: [] } },
      'produced',
    );
    await tick();

    // The live produce already fired onStandbyProducer once; clear it so we count
    // ONLY the reopen re-announce.
    onStandbyProducer.mockClear();

    factory.reannounceLocalProducersUp('roomS');
    await tick();

    expect(onStandbyProducer).toHaveBeenCalledTimes(1);
    const call = onStandbyProducer.mock.calls[0]!;
    expect(call[0]).toBe('roomS');   // roomId
    expect(call[3]).toBe('clientS'); // the original local publisher (REQ-RMS-029)

    client.close();
  });

  it('RED-RB-6b1: re-fan-on-attach replays REVERSE-MINTED hub copies DOWN to a new standby, EXCLUDING any whose origin IS that standby (REQ-RMS-036)', async () => {
    // GAP COVERAGE (ledger B4b #2): RED-RB-4a exercises the LOCAL-producer re-fan
    // arm (signaling.ts:780-784) with an EMPTY originRegistry. THIS test isolates
    // the REVERSE-MINTED arm (signaling.ts:790-795) -- the hub copies of OTHER
    // standbys' streams -- and proves the exclude-origin guard (line 793) never
    // echoes a producer back to the standby it came from.
    const onPrimaryProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onPrimaryProducer,
      attachPeerSocket: vi.fn(),
    };
    const { wss, port, factory } = await startServer(interRelay, 'relay-secret');
    server = wss;

    // A local client joins to CREATE the room (registerReverseMinted no-ops on an
    // unknown room). It does NOT produce -- so the LOCAL-producer re-fan arm
    // contributes ZERO onPrimaryProducer calls and we observe the reverse arm alone.
    const client = await connectPlain(port);
    await sendAndAwait(client, { type: 'join', roomId: 'roomA', peerId: 'clientLocal' }, 'routerRtpCapabilities');
    await tick();

    // Seed the originRegistry with TWO reverse-minted hub copies via the real seam:
    //   - one whose origin is standbyC (a DIFFERENT relay -> MUST be re-fanned to B)
    //   - one whose origin is standbyB (the relay about to attach -> MUST be excluded)
    const mintedFromC = { id: 'rev-minted-C', kind: 'video' as const, on: vi.fn() } as any;
    const mintedFromB = { id: 'rev-minted-B', kind: 'video' as const, on: vi.fn() } as any;
    factory.registerReverseMinted('roomA', mintedFromC, 'ws://standbyC', 'clientC');
    factory.registerReverseMinted('roomA', mintedFromB, 'ws://standbyB', 'clientB');

    // registerReverseMinted hub-fans immediately to ALREADY-attached peers (none
    // yet) -- clear so we count ONLY the re-fan triggered by the attach below.
    onPrimaryProducer.mockClear();

    // standbyB attaches as a TAGGED inter-relay peer -> triggers re-fan-on-attach.
    const standby = await connectInterRelay(port, 'relay-secret', 'ws://standbyB');
    await tick();

    // Exactly ONE reverse-minted re-fan reaches standbyB: the standbyC-origin copy.
    const calls = onPrimaryProducer.mock.calls.filter((c) => c[3] === 'ws://standbyB');
    expect(calls.length).toBe(1);
    expect(calls[0]![2]).toBe(mintedFromC);  // the live minted Producer handle
    expect(calls[0]![4]).toBe('clientC');    // original publisher (REQ-RMS-029)
    // EXCLUDE-ORIGIN (REQ-RMS-036): the standbyB-origin copy is NEVER echoed back.
    expect(calls.some((c) => c[2] === mintedFromB)).toBe(false);

    client.close();
    standby.close();
  });

  it('RED-RB-6b2: a reverse-minted producer whose @close fired is dropped from the originRegistry and is NOT re-fanned on a later attach (REQ-RMS-036 cleanup teeth)', async () => {
    // TEETH for the @close cleanup arm (signaling.ts:2003). Prior units mocked
    // minted.on = vi.fn() so @close NEVER fired -> the cleanup was uncovered. Here
    // the fake Producer CAPTURES the '@close' handler the factory registers, fires
    // it (as the real Producer would on close), and proves the entry is gone so the
    // dead handle is never replayed to a freshly-attached standby.
    const onPrimaryProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onPrimaryProducer,
      attachPeerSocket: vi.fn(),
    };
    const { wss, port, factory } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const client = await connectPlain(port);
    await sendAndAwait(client, { type: 'join', roomId: 'roomA', peerId: 'clientLocal' }, 'routerRtpCapabilities');
    await tick();

    const closeHandlers: Array<() => void> = [];
    const mintedFromC = {
      id: 'rev-minted-C',
      kind: 'video' as const,
      closed: false,
      on: (ev: string, cb: () => void) => { if (ev === '@close') closeHandlers.push(cb); },
    } as any;
    factory.registerReverseMinted('roomA', mintedFromC, 'ws://standbyC', 'clientC');

    // The @close arm MUST be wired (teeth: drop this assertion's target -> RED).
    expect(closeHandlers.length).toBe(1);
    closeHandlers.forEach((cb) => cb()); // producer closes -> originRegistry entry dropped
    onPrimaryProducer.mockClear();

    const standby = await connectInterRelay(port, 'relay-secret', 'ws://standbyB');
    await tick();

    // The closed producer is GONE from the registry -> never replayed to standbyB.
    expect(onPrimaryProducer.mock.calls.some((c) => c[2] === mintedFromC)).toBe(false);

    client.close();
    standby.close();
  });

  it('RED-RB-6b3: re-fan-on-attach SKIPS a .closed reverse-minted producer even if its registry entry survived (defense-in-depth guard); a live sibling is still re-fanned', async () => {
    // Defense-in-depth for a REGRESSED/missed @close: if the cleanup ever fails to
    // drop a closed producer, the re-fan loop must not echo a dead handle. `on:
    // vi.fn()` NEVER fires @close, so the entry SURVIVES; setting .closed=true
    // simulates the closed-but-still-registered state. The guard skips ONLY the
    // closed one -- the live sibling is still re-fanned (selective, not a blanket).
    const onPrimaryProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onPrimaryProducer,
      attachPeerSocket: vi.fn(),
    };
    const { wss, port, factory } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const client = await connectPlain(port);
    await sendAndAwait(client, { type: 'join', roomId: 'roomA', peerId: 'clientLocal' }, 'routerRtpCapabilities');
    await tick();

    // Both origins differ from the attaching standbyB (so neither is excluded by origin).
    const mintedClosed = { id: 'rev-closed', kind: 'video' as const, closed: false, on: vi.fn() } as any;
    const mintedLive = { id: 'rev-live', kind: 'video' as const, closed: false, on: vi.fn() } as any;
    factory.registerReverseMinted('roomA', mintedClosed, 'ws://standbyC', 'clientC');
    factory.registerReverseMinted('roomA', mintedLive, 'ws://standbyD', 'clientD');

    mintedClosed.closed = true; // closed, but its entry was NOT cleaned up (regression sim)
    onPrimaryProducer.mockClear();

    const standby = await connectInterRelay(port, 'relay-secret', 'ws://standbyB');
    await tick();

    const toB = onPrimaryProducer.mock.calls.filter((c) => c[3] === 'ws://standbyB');
    expect(toB.some((c) => c[2] === mintedClosed)).toBe(false); // RED today: re-fanned w/o the guard
    expect(toB.some((c) => c[2] === mintedLive)).toBe(true);    // live sibling still re-fanned

    client.close();
    standby.close();
  });
});
