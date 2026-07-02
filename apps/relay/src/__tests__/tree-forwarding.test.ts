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
  const layout = deriveTree(ids, { degreeCap: 2, maxHeight: 3 }); // D=2: R0 root; {0x01,0x02}; {0x03,0x04}
  it('root → "root"', () => expect(treeRoleOf(layout, '0x00')).toBe('root'));
  it('internal (parent AND children) → "internal"', () => expect(treeRoleOf(layout, '0x01')).toBe('internal'));
  it('leaf (parent, no children) → "leaf"', () => expect(treeRoleOf(layout, '0x03')).toBe('leaf'));
  it('unknown id → "leaf" (fail-safe)', () => expect(treeRoleOf(layout, '0xZZ')).toBe('leaf'));
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
});
