/**
 * Unit tests for cascade-tree Phase T-B tree-aware forwarding.
 * REQ-RMS-042 / 044 / 046 / 048.
 * All pure/synchronous — no mediasoup, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { buildPipeProducerAnnounce, isPipeProducerAnnounce, deriveTree, treeRoleOf, toCanonicalRelayId } from '@dvconf/inter-relay-client';

describe('T-B byte-stability guards (REQ-RMS-048) — MUST stay green through every task', () => {
  it('a default announce frame has EXACTLY the shipped keys (no tree fields)', () => {
    const frame = buildPipeProducerAnnounce('room1', { id: 'prod1', kind: 'video' });
    expect(Object.keys(frame).sort()).toEqual(['kind', 'producerId', 'roomId', 'type']);
    expect('hopTtl' in frame).toBe(false);
    expect('originProducerId' in frame).toBe(false);
  });
  it('a pre-tree frame (no hopTtl/originProducerId) still validates (back-compat)', () => {
    expect(isPipeProducerAnnounce({
      type: 'pipe-producer', roomId: 'room1', producerId: 'prod1', kind: 'video',
    })).toBe(true);
  });
});

describe('treeRoleOf (REQ-RMS-042)', () => {
  const ids = ['0x00', '0x01', '0x02', '0x03', '0x04'];
  // D=2: 0x00 root; children {0x01 [internal], 0x02 [leaf]}; 0x01's children {0x03,0x04 [leaves]}
  const layout = deriveTree(ids, { degreeCap: 2, maxHeight: 3 });
  it('root → "root"', () => expect(treeRoleOf(layout, '0x00')).toBe('root'));
  it('internal (parent AND children) → "internal"', () => expect(treeRoleOf(layout, '0x01')).toBe('internal'));
  it('leaf (parent, no children) → "leaf"', () => expect(treeRoleOf(layout, '0x03')).toBe('leaf'));
  it('unknown id → "leaf" (fail-safe)', () => expect(treeRoleOf(layout, '0xZZ')).toBe('leaf'));
  it('single-node tree root (parent===null, no children) → "leaf" (no forwarding targets)', () => {
    const solo = deriveTree(['0x00'], { degreeCap: 2, maxHeight: 3 });
    expect(treeRoleOf(solo, '0x00')).toBe('leaf');
  });
});

describe('toCanonicalRelayId (REQ-RMS-039)', () => {
  it('lowercases, trims, AND zero-pads to 0x+64hex', () =>
    expect(toCanonicalRelayId('  0xAB  ')).toBe('0x' + '0'.repeat(62) + 'ab')); // 66 chars
  it('pads short-form so lexical sort == numeric sort', () => {
    const p = toCanonicalRelayId('0x1');
    expect(p).toBe('0x' + '0'.repeat(63) + '1');
    expect(p.length).toBe(66);
  });
  it('leaves an already-canonical 64-hex id unchanged', () => {
    const full = '0x' + 'a'.repeat(64);
    expect(toCanonicalRelayId(full)).toBe(full);
  });
  it('pads a bare hex id with no 0x prefix', () =>
    expect(toCanonicalRelayId('ab')).toBe('0x' + '0'.repeat(62) + 'ab'));
  it('throws on oversized hex (>64 chars) rather than silently truncating', () =>
    expect(() => toCanonicalRelayId('0x' + 'a'.repeat(65))).toThrow());
});

describe('hopTtl + originProducerId on PipeProducerAnnounce (T5, REQ-RMS-044/046)', () => {
  it('builder OMITS both when not passed (byte-stable default)', () => {
    const f = buildPipeProducerAnnounce('r', { id: 'p', kind: 'video' });
    expect('hopTtl' in f).toBe(false);
    expect('originProducerId' in f).toBe(false);
  });
  it('builder INCLUDES both when passed', () => {
    const f = buildPipeProducerAnnounce('r', { id: 'p', kind: 'video' }, 'peerA', 'ws://relay', undefined, 3, 'origin-1');
    expect(f.hopTtl).toBe(3);
    expect(f.originProducerId).toBe('origin-1');
  });
  it('guard accepts numeric hopTtl + string originProducerId', () => {
    expect(isPipeProducerAnnounce({ type: 'pipe-producer', roomId: 'r', producerId: 'p', kind: 'video', hopTtl: 2, originProducerId: 'o' })).toBe(true);
  });
  it('guard REJECTS a non-numeric hopTtl', () => {
    expect(isPipeProducerAnnounce({ type: 'pipe-producer', roomId: 'r', producerId: 'p', kind: 'video', hopTtl: 'x' })).toBe(false);
  });
  it('guard REJECTS a non-string originProducerId', () => {
    expect(isPipeProducerAnnounce({ type: 'pipe-producer', roomId: 'r', producerId: 'p', kind: 'video', originProducerId: 42 })).toBe(false);
  });
});
