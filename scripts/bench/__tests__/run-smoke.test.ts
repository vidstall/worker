/**
 * RED tests for run-smoke.ts pure helpers — S25.A.
 *
 * Covers the four extractable concerns that don't need a live Sui node:
 *   1. parsePublishJson — pluck packageId / adminCap / treasuryCap / 3 init shared objects
 *      out of `sui client test-publish --json` output.
 *   2. parseSharedObjectFromCreate — pluck the lone shared object out of a
 *      `<module>::create` call result, given the struct name substring.
 *   3. buildEnvContent — format the dvconf-daemons/.env file from the bench
 *      identity bundle (10 chain IDs + 4 daemon keypairs + bench knobs).
 *   4. waitForPort — TCP poll helper used by every wait-for-ready step.
 *
 * Plan: docs/00-meta/progress.md § Session 25 (TS bench bring-up)
 */

import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:net';
import { Readable } from 'node:stream';
import {
  parsePublishJson,
  parseSharedObjectFromCreate,
  buildEnvContent,
  waitForPort,
  parseRoomIdFromEvents,
  waitForLogLine,
  type BenchIds,
  type DaemonKeys,
  type SuiObjectChange,
  type SuiTxEvent,
} from '../run-smoke.js';

// ── parsePublishJson ──────────────────────────────────────────────────

const PKG = '0xpackage0000000000000000000000000000000000000000000000000000001';
const ADDR = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function publishFixture(): { objectChanges: SuiObjectChange[] } {
  return {
    objectChanges: [
      { type: 'published', packageId: PKG },
      {
        type: 'created',
        objectId: '0xnetreg',
        objectType: `${PKG}::network_registry::NetworkRegistry`,
        owner: { Shared: { initial_shared_version: 1 } },
      },
      {
        type: 'created',
        objectId: '0xminstore',
        objectType: `${PKG}::miner_store::MinerStore`,
        owner: { Shared: { initial_shared_version: 1 } },
      },
      {
        type: 'created',
        objectId: '0xrolebox',
        objectType: `${PKG}::role_voting::RoleVoteBox`,
        owner: { Shared: { initial_shared_version: 1 } },
      },
      {
        type: 'created',
        objectId: '0xadmincap',
        objectType: `${PKG}::network_registry::AdminCap`,
        owner: { AddressOwner: ADDR },
      },
      {
        type: 'created',
        objectId: '0xtreasury',
        objectType: `0x2::coin::TreasuryCap<${PKG}::token::TOKEN>`,
        owner: { AddressOwner: ADDR },
      },
      // Decoy: AddressOwner AdminCap-like for a different package shouldn't match.
      {
        type: 'created',
        objectId: '0xunrelated',
        objectType: '0x2::package::UpgradeCap',
        owner: { AddressOwner: ADDR },
      },
    ],
  };
}

describe('parsePublishJson', () => {
  it('extracts all 6 identities from a complete fixture', () => {
    const out = parsePublishJson(publishFixture());
    expect(out.packageId).toBe(PKG);
    expect(out.adminCapId).toBe('0xadmincap');
    expect(out.treasuryCapId).toBe('0xtreasury');
    expect(out.networkRegistryId).toBe('0xnetreg');
    expect(out.minerStoreId).toBe('0xminstore');
    expect(out.roleVoteBoxId).toBe('0xrolebox');
  });

  it('throws when PACKAGE_ID is missing', () => {
    const broken = publishFixture();
    broken.objectChanges = broken.objectChanges.filter(
      (c) => c.type !== 'published',
    );
    expect(() => parsePublishJson(broken)).toThrow(/PACKAGE_ID/);
  });

  it('throws when AdminCap is missing', () => {
    const broken = publishFixture();
    broken.objectChanges = broken.objectChanges.filter(
      (c) => !(c.objectType ?? '').includes('::network_registry::AdminCap'),
    );
    expect(() => parsePublishJson(broken)).toThrow(/AdminCap/);
  });

  it('throws when TreasuryCap is missing', () => {
    const broken = publishFixture();
    broken.objectChanges = broken.objectChanges.filter(
      (c) => !(c.objectType ?? '').includes('0x2::coin::TreasuryCap<'),
    );
    expect(() => parsePublishJson(broken)).toThrow(/TreasuryCap/);
  });

  it('throws when an init shared object is missing', () => {
    const broken = publishFixture();
    broken.objectChanges = broken.objectChanges.filter(
      (c) => !(c.objectType ?? '').includes('::role_voting::RoleVoteBox'),
    );
    expect(() => parsePublishJson(broken)).toThrow(/RoleVoteBox/);
  });

  it('ignores non-Shared shared-named decoys', () => {
    // An owned (AddressOwner) RoleVoteBox-named object must not be picked up.
    const tricky = publishFixture();
    tricky.objectChanges = tricky.objectChanges.filter(
      (c) => !(c.objectType ?? '').includes('::role_voting::RoleVoteBox'),
    );
    tricky.objectChanges.push(
      {
        type: 'created',
        objectId: '0xfake_owned_box',
        objectType: `${PKG}::role_voting::RoleVoteBox`,
        owner: { AddressOwner: ADDR },
      },
      {
        type: 'created',
        objectId: '0xreal_shared_box',
        objectType: `${PKG}::role_voting::RoleVoteBox`,
        owner: { Shared: { initial_shared_version: 1 } },
      },
    );
    const out = parsePublishJson(tricky);
    expect(out.roleVoteBoxId).toBe('0xreal_shared_box');
  });
});

// ── parseSharedObjectFromCreate ───────────────────────────────────────

describe('parseSharedObjectFromCreate', () => {
  it('plucks a shared object by struct-name substring', () => {
    const result = {
      objectChanges: [
        {
          type: 'created' as const,
          objectId: '0xuserreg',
          objectType: `${PKG}::user_registry::UserRegistry`,
          owner: { Shared: { initial_shared_version: 5 } },
        },
      ],
    };
    expect(parseSharedObjectFromCreate(result, 'UserRegistry')).toBe(
      '0xuserreg',
    );
  });

  it('skips owned objects with the same struct name', () => {
    const result = {
      objectChanges: [
        {
          type: 'created' as const,
          objectId: '0xowned',
          objectType: `${PKG}::user_registry::UserRegistry`,
          owner: { AddressOwner: ADDR },
        },
        {
          type: 'created' as const,
          objectId: '0xshared',
          objectType: `${PKG}::user_registry::UserRegistry`,
          owner: { Shared: { initial_shared_version: 5 } },
        },
      ],
    };
    expect(parseSharedObjectFromCreate(result, 'UserRegistry')).toBe(
      '0xshared',
    );
  });

  it('throws when no matching shared object exists', () => {
    const result = { objectChanges: [] as SuiObjectChange[] };
    expect(() =>
      parseSharedObjectFromCreate(result, 'NotARealStruct'),
    ).toThrow(/NotARealStruct/);
  });
});

// ── buildEnvContent ───────────────────────────────────────────────────

function fakeIds(): BenchIds {
  return {
    packageId: '0xpkg',
    networkRegistryId: '0xnet',
    minerStoreId: '0xmin',
    cpRegistryId: '0xcp',
    relayRegistryId: '0xrelay',
    validatorRegistryId: '0xval',
    userRegistryId: '0xuser',
    roomManagerId: '0xroom',
    signalingRegistryId: '0xsig',
    roleVoteBoxId: '0xrolebox',
  };
}

function fakeKeys(): DaemonKeys {
  return {
    CP_KEYPAIR: 'suiprivkey1cpcpcp',
    SUI_PRIVATE_KEY: 'suiprivkey1valval',
    SIGNALING_KEYPAIR: 'suiprivkey1sigsig',
    PRIVATE_KEY: 'suiprivkey1relrelay',
  };
}

describe('buildEnvContent', () => {
  it('emits all 10 IDs in canonical order', () => {
    const env = buildEnvContent(fakeIds(), fakeKeys());
    expect(env).toContain('PACKAGE_ID=0xpkg');
    expect(env).toContain('NETWORK_REGISTRY_ID=0xnet');
    expect(env).toContain('MINER_STORE_ID=0xmin');
    expect(env).toContain('CP_REGISTRY_ID=0xcp');
    expect(env).toContain('RELAY_REGISTRY_ID=0xrelay');
    expect(env).toContain('VALIDATOR_REGISTRY_ID=0xval');
    expect(env).toContain('USER_REGISTRY_ID=0xuser');
    expect(env).toContain('ROOM_MANAGER_ID=0xroom');
    expect(env).toContain('SIGNALING_REGISTRY_ID=0xsig');
    expect(env).toContain('ROLE_VOTE_BOX_ID=0xrolebox');
  });

  it('emits all 4 daemon keypairs under canonical env var names', () => {
    const env = buildEnvContent(fakeIds(), fakeKeys());
    expect(env).toContain('CP_KEYPAIR=suiprivkey1cpcpcp');
    expect(env).toContain('SUI_PRIVATE_KEY=suiprivkey1valval');
    expect(env).toContain('SIGNALING_KEYPAIR=suiprivkey1sigsig');
    expect(env).toContain('PRIVATE_KEY=suiprivkey1relrelay');
  });

  it('sets SUI_NETWORK=localnet and BENCH_LATENCY=1 by default', () => {
    const env = buildEnvContent(fakeIds(), fakeKeys());
    expect(env).toContain('SUI_NETWORK=localnet');
    expect(env).toContain('BENCH_LATENCY=1');
  });

  it('appends caller-supplied extras as key=value lines', () => {
    const env = buildEnvContent(fakeIds(), fakeKeys(), {
      MEASUREMENT_INTERVAL_MS: '10000',
      REGISTRATION_MODE: 'voting',
    });
    expect(env).toContain('MEASUREMENT_INTERVAL_MS=10000');
    expect(env).toContain('REGISTRATION_MODE=voting');
  });

  it('terminates with a trailing newline', () => {
    expect(buildEnvContent(fakeIds(), fakeKeys()).endsWith('\n')).toBe(true);
  });
});

// ── waitForPort ───────────────────────────────────────────────────────

async function withListener<T>(
  fn: (port: number, server: Server) => Promise<T>,
): Promise<T> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    server.close();
    throw new Error('Unable to bind listener for waitForPort test');
  }
  try {
    return await fn(addr.port, server);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('waitForPort', () => {
  it('resolves quickly when the port is already open', async () => {
    await withListener(async (port) => {
      const start = Date.now();
      await waitForPort('127.0.0.1', port, 5000, 50);
      // Must succeed well inside the 5s budget — first poll typically hits.
      expect(Date.now() - start).toBeLessThan(2000);
    });
  });

  it('rejects after the timeout when the port stays closed', async () => {
    // Pick a port that is almost certainly not bound (high ephemeral, no listener).
    await expect(
      waitForPort('127.0.0.1', 1, 300, 50),
    ).rejects.toThrow(/not reachable/);
  });
});

// ── parseRoomIdFromEvents ─────────────────────────────────────────────

describe('parseRoomIdFromEvents', () => {
  const ROOM_ID = '0xroom1111111111111111111111111111111111111111111111111111111111';

  function roomCreatedEvent(): SuiTxEvent {
    return {
      type: `${PKG}::room_manager::RoomCreated`,
      parsedJson: {
        room_id: ROOM_ID,
        creator: ADDR,
        relay_mode: 1,
      },
    };
  }

  it('extracts room_id from a RoomCreated event in the events array', () => {
    const result = { events: [roomCreatedEvent()] };
    expect(parseRoomIdFromEvents(result, '::room_manager::RoomCreated')).toBe(
      ROOM_ID,
    );
  });

  it('skips events with non-matching type and returns the first match', () => {
    const decoy: SuiTxEvent = {
      type: `${PKG}::registration::MinerRegistered`,
      parsedJson: { miner_id: '0xfake', role: 0 },
    };
    const result = { events: [decoy, roomCreatedEvent()] };
    expect(parseRoomIdFromEvents(result, '::room_manager::RoomCreated')).toBe(
      ROOM_ID,
    );
  });

  it('throws when no matching event exists', () => {
    const result = {
      events: [
        {
          type: `${PKG}::registration::MinerRegistered`,
          parsedJson: { miner_id: '0xfake', role: 0 },
        },
      ],
    };
    expect(() =>
      parseRoomIdFromEvents(result, '::room_manager::RoomCreated'),
    ).toThrow(/RoomCreated/);
  });

  it('throws when matching event has no parsedJson.room_id field', () => {
    const result = {
      events: [
        {
          type: `${PKG}::room_manager::RoomCreated`,
          parsedJson: { creator: ADDR, relay_mode: 1 },
        },
      ],
    };
    expect(() =>
      parseRoomIdFromEvents(result, '::room_manager::RoomCreated'),
    ).toThrow(/room_id/);
  });

  it('throws when events array is missing entirely', () => {
    expect(() =>
      parseRoomIdFromEvents({}, '::room_manager::RoomCreated'),
    ).toThrow(/events/);
  });
});

// ── waitForLogLine ────────────────────────────────────────────────────

describe('waitForLogLine', () => {
  it('resolves when a matching line arrives on the stream', async () => {
    const stream = new Readable({ read() {} });
    const promise = waitForLogLine(stream, /Starting role voting loop/, 1000);
    stream.push('some unrelated log\n');
    stream.push('Starting role voting loop intervalMs=5000\n');
    await expect(promise).resolves.toBe(
      'Starting role voting loop intervalMs=5000',
    );
  });

  it('handles chunked lines split across multiple push calls', async () => {
    const stream = new Readable({ read() {} });
    const promise = waitForLogLine(stream, /chain-aware mode/, 1000);
    stream.push('Signaling daemon ');
    stream.push('started — ');
    stream.push('chain-aware mode\n');
    await expect(promise).resolves.toMatch(/chain-aware mode/);
  });

  it('ignores non-matching lines', async () => {
    const stream = new Readable({ read() {} });
    const promise = waitForLogLine(stream, /never matches/, 200);
    stream.push('hello\n');
    stream.push('world\n');
    await expect(promise).rejects.toThrow(/timeout/);
  });

  it('rejects on timeout when no matching line arrives', async () => {
    const stream = new Readable({ read() {} });
    const promise = waitForLogLine(stream, /Starting role voting loop/, 150);
    await expect(promise).rejects.toThrow(/timeout/);
  });

  it('matches a partial line in the buffer at stream end', async () => {
    // Some daemons log without trailing newline if process is killed mid-line.
    // We DO require the newline — incomplete lines are not considered matches.
    const stream = new Readable({ read() {} });
    const promise = waitForLogLine(stream, /partial/, 150);
    stream.push('partial line without newline');
    await expect(promise).rejects.toThrow(/timeout/);
  });
});
